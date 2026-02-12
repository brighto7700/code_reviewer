import os
import logging
import asyncio
import time
from datetime import datetime, timezone, timedelta

# Telegram libraries
from telegram import Update
from telegram.ext import ApplicationBuilder, ContextTypes, CommandHandler, MessageHandler, filters

# xAI (Grok) libraries
from openai import OpenAI

# --- CONFIGURATION (Replit Style) ---
try:
    TELEGRAM_TOKEN = os.environ['TELEGRAM_TOKEN']
    XAI_API_KEY = os.environ['XAI_API_KEY']
except KeyError:
    print("❌ ERROR: Keys not found! Please open the Secrets tab (Lock icon) and add TELEGRAM_TOKEN and XAI_API_KEY.")
    exit(1)

# --- GROK SETUP ---
client = OpenAI(
    api_key=XAI_API_KEY,
    base_url="https://api.x.ai/v1",
)
MODEL_NAME = "grok-2-1212"

# --- LOGGING SETUP ---
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)

# --- HELPER FUNCTION: GET GROK RESPONSE SAFELY ---
async def get_grok_response(prompt, retries=3):
    """Tries to get a response from Grok."""
    for attempt in range(retries):
        try:
            # We use asyncio.to_thread because the OpenAI client is synchronous
            response = await asyncio.to_thread(
                client.chat.completions.create,
                model=MODEL_NAME,
                messages=[
                    {"role": "system", "content": "You are a senior software engineer and code reviewer. Your goal is to analyze code, find bugs, suggest optimizations, and explain best practices. Be concise but helpful."},
                    {"role": "user", "content": prompt}
                ]
            )
            return response.choices[0].message.content
        except Exception as e:
            if "rate_limit" in str(e).lower():
                wait_time = 5 * (attempt + 1)
                logging.warning(f"⚠️ Rate limit hit. Waiting {wait_time} seconds...")
                await asyncio.sleep(wait_time)
            else:
                return f"⚠️ Error: {str(e)}"
    return "⚠️ System is too busy. Please try again in a minute."

# --- BOT FUNCTIONS ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await context.bot.send_message(
        chat_id=update.effective_chat.id,
        text="I am ready! I'm now powered by xAI Grok. Mention me or reply to a message with code, and I will review it."
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
    status_msg = await context.bot.send_message(chat_id=chat_id, text="👀 Reviewing code with Grok...")

    # 3. Get Response with Retry Logic
    bot_response = await get_grok_response(user_message)

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

    print("✅ Bot is running on Replit with Grok...")
    application.run_polling(drop_pending_updates=True)