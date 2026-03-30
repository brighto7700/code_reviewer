import os
import sys
import asyncio
import traceback
from threading import Thread
from flask import Flask

# --- THE MAGIC BULLET ---
# Force Python to print logs instantly so Pxxl App can't hide them!
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except AttributeError:
    pass 

print("🚀 Booting up CodeBot system...")

# --- 1. UNKILLABLE WEB SERVER (Runs in Main Thread) ---
app = Flask(__name__)

@app.route('/')
def health_check():
    return "CodeBot is Online!", 200

# --- 2. BOT LOGIC (Protected in a bubble) ---
def run_bot():
    print("📡 Initializing Telegram Bot...")
    try:
        from telegram import Update
        from telegram.constants import ChatType
        from telegram.ext import ApplicationBuilder, ContextTypes, CommandHandler, MessageHandler, filters
        from groq import Groq

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

            messages_payload = [{"role": "system", "content": "You are CodeBot, an expert senior software engineer and code reviewer."}]
            if replied_code:
                messages_payload.append({"role": "user", "content": f"HERE IS THE CODE CONTEXT:\n```\n{replied_code}\n```"})
            messages_payload.append({"role": "user", "content": user_text})

            try:
                status_msg = await context.bot.send_message(chat_id=chat_id, text=f"⚡ {context_status}", reply_to_message_id=target_msg_id)
                chat_completion = client.chat.completions.create(messages=messages_payload, model=MODEL_NAME, temperature=0.6)
                bot_response = chat_completion.choices[0].message.content
                await context.bot.edit_message_text(chat_id=chat_id, message_id=status_msg.message_id, text=bot_response, parse_mode='Markdown')
            except Exception as ai_err:
                print(f"AI Error: {ai_err}")

        # Check token directly
        telegram_token = os.environ.get('TELEGRAM_TOKEN', '').strip()
        if not telegram_token:
            print("❌ ERROR: TELEGRAM_TOKEN missing from environment variables!")
            return
        
        print(f"✅ Keys loaded! Building Bot with token starting with: {telegram_token[:4]}")
        
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        application = ApplicationBuilder().token(telegram_token).build()
        application.add_handler(CommandHandler('start', start))
        application.add_handler(MessageHandler(filters.TEXT & (~filters.COMMAND), handle_message))
        
        print("✅ Bot is actively polling!")
        application.run_polling(drop_pending_updates=True, stop_signals=())

    except Exception as e:
        print("\n❌❌❌ FATAL BOT CRASH ❌❌❌")
        traceback.print_exc()
        print("❌❌❌======================❌❌❌\n")

# --- 3. EXECUTION ---
if __name__ == '__main__':
    # 1. Launch bot safely in the background
    bot_thread = Thread(target=run_bot, daemon=True)
    bot_thread.start()

    # 2. Launch web server in the MAIN thread so it NEVER closes!
    port = int(os.environ.get("PORT", 8080))
    print(f"🌐 Binding web server to port {port}...")
    app.run(host='0.0.0.0', port=port, use_reloader=False)
