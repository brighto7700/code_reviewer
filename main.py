import os
import logging
import asyncio
from threading import Thread # Added for Keep-Alive
from flask import Flask      # Added for Keep-Alive

# Telegram libraries
from telegram import Update
from telegram.constants import ChatType
from telegram.ext import ApplicationBuilder, ContextTypes, CommandHandler, MessageHandler, filters

# Groq library
from groq import Groq

# --- KEEP ALIVE SETUP (For Render Free Tier) ---
app = Flask(__name__)

@app.route('/')
def health_check():
    return "CodeBot is Online!", 200

def run_flask():
    # Render provides a PORT environment variable automatically
    port = int(os.environ.get("PORT", 8080))
    app.run(host='0.0.0.0', port=port)

def keep_alive():
    t = Thread(target=run_flask)
    t.daemon = True
    t.start()

# --- CONFIGURATION ---
try:
    TELEGRAM_TOKEN = os.environ['TELEGRAM_TOKEN']
    GROQ_API_KEY = os.environ['GROQ_API_KEY']
except KeyError:
    print("❌ ERROR: Keys not found! Add TELEGRAM_TOKEN and GROQ_API_KEY to Environment Variables.")
    exit(1)

# --- GROQ SETUP ---
client = Groq(api_key=GROQ_API_KEY)
MODEL_NAME = "llama-3.3-70b-versatile"

# --- LOGGING SETUP ---
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)

# [Your existing start and handle_message functions remain exactly the same]
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await context.bot.send_message(
        chat_id=update.effective_chat.id,
        text=(
            "🧠 **I am CodeBot (Smart Mode)**\n\n"
            "No commands needed! Just talk to me naturally."
        )
    )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # (Existing logic you provided...)
    user_text = update.message.text
    chat_type = update.message.chat.type
    chat_id = update.effective_chat.id
    
    should_reply = False
    if chat_type == ChatType.PRIVATE: 
        should_reply = True
    if f"@{context.bot.username}" in user_text or "codebot" in user_text.lower():
        should_reply = True
    if update.message.reply_to_message and update.message.reply_to_message.from_user.id == context.bot.id:
        should_reply = True

    if not should_reply:
        return

    replied_code = ""
    target_msg_id = update.message.message_id
    if update.message.reply_to_message:
        replied_code = update.message.reply_to_message.text or update.message.reply_to_message.caption
        target_msg_id = update.message.reply_to_message.message_id
        context_status = "Scanning context..."
    else:
        context_status = "Thinking..."

    system_prompt = "You are CodeBot..." # (Your existing system prompt)
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
        print(f"Error: {e}")

if __name__ == '__main__':
    # 1. Start the Flask server in the background
    print("📡 Starting Keep-Alive server...")
    keep_alive()

    # 2. Start the Telegram Bot
    application = ApplicationBuilder().token(TELEGRAM_TOKEN).build()
    application.add_handler(CommandHandler('start', start))
    application.add_handler(MessageHandler(filters.TEXT & (~filters.COMMAND), handle_message))

    print(f"✅ CodeBot Smart Mode is running on {MODEL_NAME}...")
    application.run_polling(drop_pending_updates=True)
    
