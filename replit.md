# Replit Agent Configuration

## Overview

This is a Telegram bot that integrates with Google's Gemini AI (specifically the `gemini-2.0-flash` model) to serve as a senior software engineer and code reviewer. Users interact with the bot through Telegram, sending code or questions, and the bot analyzes code, finds bugs, suggests optimizations, and explains best practices using Gemini AI.

The project is currently in an early/incomplete state — it has the configuration, Gemini setup, and a helper function, but is missing the actual bot command handlers, message handlers, and the application entry point to run the bot.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Application Structure

- **Single-file architecture**: The entire application lives in `main.py`. This is a simple bot with no frontend — it's a backend-only service that communicates via the Telegram Bot API.
- **Runtime**: Python, designed to run on Replit.

### Core Components

1. **Telegram Bot Layer** — Uses `python-telegram-bot` library (`telegram.ext`) for handling incoming messages and commands. The bot uses `ApplicationBuilder` to construct the app and registers `CommandHandler` and `MessageHandler` instances for routing.

2. **AI/LLM Layer** — Uses Google's `google-generativeai` SDK to call the Gemini 2.0 Flash model. The model is configured with a system instruction that frames it as a code reviewer. All AI calls go through the `get_gemini_response()` helper which includes retry logic with exponential backoff for rate limiting (`ResourceExhausted` errors).

3. **Configuration** — All secrets (`TELEGRAM_TOKEN`, `GEMINI_API_KEY`) are loaded from environment variables (Replit Secrets). The app exits with a clear error message if these are missing.

### Key Design Decisions

- **Rate limit handling**: The `get_gemini_response` function retries up to 3 times with increasing wait times (5s, 10s, 15s) when hitting Gemini API rate limits. This is important because free-tier Gemini API has strict rate limits.
- **Async architecture**: The bot is built with async/await patterns, which is required by `python-telegram-bot` v20+ and works well for I/O-bound operations like API calls.
- **No database**: There is no persistent storage. The bot is stateless — it doesn't store conversation history or user data.

### What Needs to Be Built

The bot is incomplete. It needs:
- Command handlers (e.g., `/start`, `/help`, `/review`)
- Message handlers to process incoming code snippets
- The `main()` function or entry point that builds the Application, registers handlers, and calls `application.run_polling()`

## External Dependencies

### APIs and Services

- **Telegram Bot API** — The bot's user interface. Requires a `TELEGRAM_TOKEN` obtained from BotFather on Telegram.
- **Google Gemini API** — Powers the AI code review functionality. Requires a `GEMINI_API_KEY` from Google AI Studio. Uses the `gemini-2.0-flash` model.

### Python Packages

- `python-telegram-bot` — Telegram bot framework (v20+ with async support)
- `google-generativeai` — Google's official Python SDK for Gemini
- `google-api-core` — Used for exception handling (specifically `ResourceExhausted`)

### Environment Variables (Replit Secrets)

| Secret | Purpose |
|--------|---------|
| `TELEGRAM_TOKEN` | Authentication token for the Telegram Bot API |
| `GEMINI_API_KEY` | API key for Google Gemini AI |