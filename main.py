import os
import logging
import asyncio
import time
from datetime import datetime, timezone, timedelta

# Telegram libraries
from telegram import Update
from telegram.ext import ApplicationBuilder, ContextTypes, CommandHandler, MessageHandler, filters

# Gemini libraries
import google.generativeai as genai
from google.api_core.exceptions import ResourceExhausted

# --- CONFIGURATION (Replit Style) ---
try:
    TELEGRAM_TOKEN = os.environ['TELEGRAM_TOKEN']
    GEMINI_API_KEY = os.environ['GEMINI_API_KEY']
except KeyError:
    print("❌ ERROR: Keys not found! Please open the Secrets tab (Lock icon) and add TELEGRAM_TOKEN and GEMINI_API_KEY.")
    exit(1)

# --- GEMINI SETUP ---
genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel(
    'gemini-2.0-flash',
    system_instruction="You are a senior software engineer and code reviewer. Your goal is to analyze code, find bugs, suggest optimizations, and explain best practices. Be concise but helpful."
)

# --- LOGGING SETUP ---
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)

# --- HELPER FUNCTION: GET GEMINI RESPONSE SAFELY ---
async def get_gemini_response(prompt, retries=3):
    """Tries to get a response, waiting if we hit a rate limit."""
    for attempt in range(retries):
        try:
            response = model.generate_content(prompt)
            return response.text
        except ResourceExhausted:
            # If we hit the limit, wait and try again
            wait_time = 5 * (attempt + 1) # Wait 5s, then 10s, then 15s
            logging.warning(f"⚠️ Rate limit hit. Waiting {wait_time} seconds...")
            await asyncio.sleep(wait_time)
        except Exception as e:
            return f"⚠️ Error: {str(e)}"
    return "⚠️ System is too busy. Please try again in a minute."

# --- BOT FUNCTIONS ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await context.bot.send_message(
        chat_id=update.effective_chat.id,
        text="I am ready! Mention me or reply to a message with code, and I will review it."
    )

async def handle_mention(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_message = update.message.text
    chat_id = update.effective_chat.id
    msg_date = update.message.date

    # 1. IGNORE OLD MESSAGES
    if datetime.now(timezone.utc) - msg_date > timedelta(seconds=120):
        logging.info(f"Skipping old message from {msg_date}")
        return

    # 2. Send "Thinking..."
    status_msg = await context.bot.send_message(chat_id=chat_id, text="👀 Reviewing code...")

    # 3. Get Response with Retry Logic
    bot_response = await get_gemini_response(user_message)

    # 4. Reply
    try:
        await context.bot.edit_message_text(
            chat_id=chat_id,
            message_id=status_msg.message_id,
            text=bot_response,
            parse_mode='Markdown'
        )
    except Exception as e:
        logging.error(f"Markdown parsing failed: {e}")
        # Sometimes Markdown parsing fails, send as plain text
        await context.bot.edit_message_text(
            chat_id=chat_id,
            message_id=status_msg.message_id,
            text=bot_response
        )

if __name__ == '__main__':
    application = ApplicationBuilder().token(TELEGRAM_TOKEN).build()

    start_handler = CommandHandler('start', start)
    mention_handler = MessageHandler(filters.Entity("mention") | filters.ChatType.PRIVATE, handle_mention)

    application.add_handler(start_handler)
    application.add_handler(mention_handler)

    print("✅ Bot is running on Replit... (Old messages will be ignored)")
    application.run_polling(drop_pending_updates=True)