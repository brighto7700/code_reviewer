import os
import sys
import asyncio
import traceback
import logging
from threading import Thread
from flask import Flask

from telegram import Update
from telegram.constants import ChatType
from telegram.ext import ApplicationBuilder, ContextTypes, CommandHandler, MessageHandler, filters
from groq import Groq

# Force logs to stream instantly instead of buffering
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except AttributeError:
    pass

# --- 1. WEB SERVER (Satisfies Pxxl App Health Check) ---
app = Flask(__name__)

@app.route('/')
def health_check():
    return "CodeBot is awake and healthy!", 200

# --- 2. TELEGRAM BOT LOGIC ---
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)
MODEL_NAME = "llama-3.3-70b-versatile"

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await context.bot.send_message(
        chat_id=update.effective_chat.id,
        text="🧠 **I am CodeBot (Smart Mode)**\n\nNo commands needed! Just talk to me naturally."
    )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    groq_key = os.environ.get('GROQ_API_KEY', '').strip()
    if not groq_key:
        await update.message.reply_text("❌ GROQ_API_KEY is missing.")
        return
    
    client = Groq(api_key=groq_key)
    user_text = update.message.text
    chat_id = update.effective_chat.id
    chat_type = update.message.chat.type
    
    should_reply = False
    if chat_type == ChatType.PRIVATE: should_reply = True
    if f"@{context.bot.username}" in user_text or "codebot" in user_text.lower(): should_reply = True
    if update.message.reply_to_message and update.message.reply_to_message.from_user.id == context.bot.id: should_reply = True

    if not should_reply: return

    replied_code = ""
    target_msg_id = update.message.message_id
    if update.message.reply_to_message:
        replied_code = update.message.reply_to_message.text or update.message.reply_to_message.caption
        target_msg_id = update.message.reply_to_message.message_id
        context_status = "Scanning context..."
    else:
        context_status = "Thinking..."

    messages_payload = [{"role": "system", "content": "You are CodeBot, an expert senior software engineer and code reviewer."}]
    if replied_code:
        messages_payload.append({"role": "user", "content": f"HERE IS THE CODE CONTEXT:\n```\n{replied_code}\n```"})
    messages_payload.append({"role": "user", "content": user_text})

    try:
        status_msg = await context.bot.send_message(chat_id=chat_id, text=f"⚡ {context_status}", reply_to_message_id=target_msg_id)
        chat_completion = client.chat.completions.create(messages=messages_payload, model=MODEL_NAME, temperature=0.6)
        bot_response = chat_completion.choices[0].message.content
        await context.bot.edit_message_text(chat_id=chat_id, message_id=status_msg.message_id, text=bot_response, parse_mode='Markdown')
    except Exception as e:
        print(f"Groq API Error: {e}")
        await context.bot.send_message(chat_id=chat_id, text="❌ An error occurred generating a response.")

def run_bot():
    print("📡 Initializing Telegram Bot in background...")
    try:
        telegram_token = os.environ.get('TELEGRAM_TOKEN', '').strip()
        if not telegram_token:
            print("❌ ERROR: TELEGRAM_TOKEN missing from environment variables!")
            return
        
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        application = ApplicationBuilder().token(telegram_token).build()
        application.add_handler(CommandHandler('start', start))
        application.add_handler(MessageHandler(filters.TEXT & (~filters.COMMAND), handle_message))
        
        print("✅ Bot is actively polling!")
        application.run_polling(drop_pending_updates=True, stop_signals=())
    except Exception as e:
        print("\n❌ FATAL BOT CRASH ❌")
        traceback.print_exc()

# --- 3. EXECUTION ---
# Moving the thread outside the __main__ block ensures it starts immediately 
# when Gunicorn imports this file, bypassing the platform's execution quirks!
bot_thread = Thread(target=run_bot, daemon=True)
bot_thread.start()

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))
    app.run(host='0.0.0.0', port=port, use_reloader=False)
