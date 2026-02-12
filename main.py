import os
import logging
import asyncio

# Telegram libraries
from telegram import Update
from telegram.constants import ChatType
from telegram.ext import ApplicationBuilder, ContextTypes, CommandHandler, MessageHandler, filters

# Groq library
from groq import Groq

# --- CONFIGURATION ---
try:
    TELEGRAM_TOKEN = os.environ['TELEGRAM_TOKEN']
    GROQ_API_KEY = os.environ['GROQ_API_KEY']
except KeyError:
    print("❌ ERROR: Keys not found! Add TELEGRAM_TOKEN and GROQ_API_KEY to Secrets.")
    exit(1)

# --- GROQ SETUP ---
client = Groq(api_key=GROQ_API_KEY)
MODEL_NAME = "llama-3.3-70b-versatile"

# --- LOGGING SETUP ---
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await context.bot.send_message(
        chat_id=update.effective_chat.id,
        text=(
            "🧠 **I am CodeBot (Smart Mode)**\n\n"
            "No commands needed! Just talk to me naturally.\n\n"
            "**Try saying:**\n"
            "• 'Roast this code for me'\n"
            "• 'Convert this to Python'\n"
            "• 'What is the Big O complexity?'\n"
            "• 'Add comments to this function'\n"
            "• 'Fix the bugs here'"
        )
    )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # 1. Get Text & Context
    user_text = update.message.text
    chat_type = update.message.chat.type
    chat_id = update.effective_chat.id

    # 2. DECISION LOGIC: Should we listen?
    should_reply = False

    # Always reply in Private DMs
    if chat_type == ChatType.PRIVATE: 
        should_reply = True

    # Reply if Mentioned or keyword "codebot" used
    if f"@{context.bot.username}" in user_text or "codebot" in user_text.lower():
        should_reply = True

    # Reply if responding to the bot
    if update.message.reply_to_message and update.message.reply_to_message.from_user.id == context.bot.id:
        should_reply = True

    if not should_reply:
        return

    # 3. GET CODE CONTEXT (Replied Message)
    replied_code = ""
    target_msg_id = update.message.message_id

    if update.message.reply_to_message:
        replied_code = update.message.reply_to_message.text or update.message.reply_to_message.caption
        target_msg_id = update.message.reply_to_message.message_id # Point to the code

        # UI Polish: If user replied to code, let's acknowledge that context
        context_status = "Scanning context..."
    else:
        context_status = "Thinking..."

    # 4. THE SMART SYSTEM PROMPT (The Brain)
    # We tell the AI how to behave based on the User's text.
    system_prompt = (
        "You are CodeBot, an intelligent and versatile developer assistant. "
        "Your behavior changes based on the user's intent:\n\n"

        "1. **ROAST MODE:** If user says 'roast', 'cook', 'hate', or 'critique' -> Be sarcastic, mean, funny, and brutally honest about code quality.\n"
        "2. **TRANSLATE MODE:** If user asks to convert/translate languages -> Output ONLY the converted code and a brief note.\n"
        "3. **COMPLEXITY MODE:** If user asks for 'Big O', 'complexity', or 'performance' -> Analyze time/space complexity mathematically.\n"
        "4. **DOCS MODE:** If user asks for 'docs', 'comments', or 'explain' -> Add docstrings and comments to the code.\n"
        "5. **DEFAULT MODE:** If none of the above, just be a helpful Senior Engineer. Find bugs and fix them.\n\n"

        "**CRITICAL:** If the user provided code (in the context), focus strictly on that code."
    )

    # 5. CONSTRUCT THE CONVERSATION
    messages_payload = [{"role": "system", "content": system_prompt}]

    # If there is code in the reply, feed it to the AI first
    if replied_code:
        messages_payload.append({
            "role": "user", 
            "content": f"HERE IS THE CODE CONTEXT:\n```\n{replied_code}\n```"
        })

    # Add the user's actual request (e.g., "Roast this!")
    messages_payload.append({"role": "user", "content": user_text})

    # 6. SEND TO GROQ
    try:
        status_msg = await context.bot.send_message(
            chat_id=chat_id, 
            text=f"⚡ {context_status}",
            reply_to_message_id=target_msg_id
        )

        chat_completion = client.chat.completions.create(
            messages=messages_payload,
            model=MODEL_NAME,
            temperature=0.6, # A bit creative for roasting/chatting
            max_tokens=2048,
        )

        bot_response = chat_completion.choices[0].message.content

        # 7. REPLY
        await context.bot.edit_message_text(
            chat_id=chat_id,
            message_id=status_msg.message_id,
            text=bot_response,
            parse_mode='Markdown'
        )

    except Exception as e:
        print(f"Error: {e}")
        # Fallback for errors
        try:
            await context.bot.edit_message_text(
                chat_id=chat_id,
                message_id=status_msg.message_id,
                text=bot_response # Try plain text if Markdown fails
            )
        except:
            pass

if __name__ == '__main__':
    application = ApplicationBuilder().token(TELEGRAM_TOKEN).build()

    # Handlers
    application.add_handler(CommandHandler('start', start))

    # Listen to EVERYTHING (Text & Replies)
    # We filter inside handle_message to decide if we should reply
    application.add_handler(MessageHandler(filters.TEXT & (~filters.COMMAND), handle_message))

    print(f"✅ CodeBot Smart Mode is running on {MODEL_NAME}...")

    application.run_polling(drop_pending_updates=True)