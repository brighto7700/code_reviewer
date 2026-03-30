import os
import logging
import asyncio
import traceback
from threading import Thread 
from flask import Flask      

# Telegram & Groq
from telegram import Update
from telegram.constants import ChatType
from telegram.ext import ApplicationBuilder, ContextTypes, CommandHandler, MessageHandler, filters
from groq import Groq

# --- 1. UNKILLABLE WEB SERVER (Guarantees Health Check Passes) ---
app = Flask(__name__)

@app.route('/')
def health_check():
    return "CodeBot Web Server is Online!", 200

# --- 2. LOGGING SETUP ---
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)
MODEL_NAME = "llama-3.3-70b-versatile"

# --- 3. BOT LOGIC (Keys load safely inside) ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await context.bot.send_message(
        chat_id=update.effective_chat.id,
        text="🧠 **I am CodeBot (Smart Mode)**\n\nNo commands needed! Just talk to me naturally."
    )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Load Groq safely inside the handler so it can't crash the server on startup
    groq_key = os.environ.get('GROQ_API_KEY')
    if not groq_key:
        await update.message.reply_text("❌ GROQ_API_KEY is missing from environment variables.")
        return
    
    client = Groq(api_key=groq_key)

    user_text = update.message.text
    chat_type = update.message.chat.type
    chat_id = update.effective_chat.id
    
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

    system_prompt = "You are CodeBot, an expert senior software engineer and code reviewer."
    messages_payload = [{"role": "system", "content": system_prompt}]
    
    if replied_code:
        messages_payload.append({"role": "user", "content": f"HERE IS THE CODE CONTEXT:\n```\n{replied_code}\n```"})
    messages_payload.append({"role": "user", "content": user_text})

    try:
        status_msg = await context.bot.send_message(chat_id=chat_id, text=f"⚡ {context_status}", reply_to_message_id=target_msg_id)
        chat_completion = client.chat.completions.create(messages=messages_payload, model=MODEL_NAME, temperature=0.6)
        bot_response = chat_completion.choices[0].message.content
        await context.bot.edit_message_text(chat_id=chat_id, message_id=status_msg.message_id, text=bot_response, parse_mode='Markdown')
    except Exception as e:
        print(f"Error during AI generation: {e}")
        await context.bot.send_message(chat_id=chat_id, text="❌ An error occurred while generating a response.")

# --- 4. SAFE BACKGROUND THREAD ---
def run_bot():
    print("📡 Starting Telegram Bot in background...")
    try:
        telegram_token = os.environ.get('TELEGRAM_TOKEN')
        if not telegram_token:
            print("❌ CRITICAL: TELEGRAM_TOKEN environment variable is missing!")
            return

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        application = ApplicationBuilder().token(telegram_token).build()
        application.add_handler(CommandHandler('start', start))
        application.add_handler(MessageHandler(filters.TEXT & (~filters.COMMAND), handle_message))
        
        print("✅ CodeBot is polling...")
        application.run_polling(drop_pending_updates=True, stop_signals=())
    except Exception as e:
        print(f"❌ BOT STARTUP CRASHED:")
        traceback.print_exc()

# Starts the exact moment Gunicorn loads the file
bot_thread = Thread(target=run_bot)
bot_thread.daemon = True
bot_thread.start()
