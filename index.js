const express = require('express');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');

// --- 1. SERVER SETUP ---
const app = express();
app.get('/', (req, res) => res.status(200).send('CodeBot Pro is Online!'));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🌐 Server active on port ${PORT}`));

// --- 2. CONFIGURATION ---
const telegramToken = process.env.TELEGRAM_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;

if (!telegramToken || !groqApiKey) {
    console.error("❌ ERROR: Missing credentials.");
    process.exit(1);
}

const bot = new Telegraf(telegramToken);
const groq = new Groq({ apiKey: groqApiKey });

const MODEL_NAME = "groq/compound";
const chatMemory = new Map();
const MAX_HISTORY = 4; // Optimized for Compound TPM limits

// --- 3. ADVANCED SYSTEM PROMPT ---
const SYSTEM_INSTRUCTION = `
You are CodeBot, a world-class Senior Software Engineer and Technical Architect. 
Your goal is to provide high-fidelity coding assistance, architectural advice, and real-time technical data.

BEHAVIORAL GUIDELINES:
1. SEARCH: You have native web access. Use it automatically for live prices, documentation updates, or current events. Never state you lack real-time data.
2. CODE QUALITY: When code is provided, silently analyze it for security vulnerabilities, performance bottlenecks, and "code smells." 
3. RESPONSE STYLE: Be concise, professional, and slightly opinionated toward industry best practices (e.g., DRY, SOLID, Clean Code).
4. FORMATTING: Use perfect Markdown. Language tags for code blocks are mandatory (e.g., \`\`\`javascript).
5. SCREENSHOTS: If a user asks to see a site or take a screenshot, reply ONLY with the tag: [SCREENSHOT:https://url].

CONSTRAINTS:
- Do not apologize for being an AI.
- If a question is ambiguous, ask for clarification before writing 100 lines of code.
- If the user provides a snippet, assume they want a review unless they ask a specific question.
`.trim();

// --- 4. UTILITIES (Retry & Summary) ---
async function requestWithRetry(payload, retries = 2) {
    try {
        return await groq.chat.completions.create(payload);
    } catch (error) {
        if (error.status === 429 && retries > 0) {
            const waitTime = error.message.match(/(\d+\.\d+)s/) ? parseFloat(error.message.match(/(\d+\.\d+)s/)[1]) * 1000 : 4000;
            console.log(`⏳ Rate limit hit. Retrying in ${waitTime/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime + 500));
            return requestWithRetry(payload, retries - 1);
        }
        throw error;
    }
}

async function summarizeForMemory(text) {
    if (!text || text.length <= 60) return text || "";
    try {
        const res = await requestWithRetry({
            messages: [
                { role: "system", content: "Summarize this technical exchange into ONE concise sentence for long-term AI context." },
                { role: "user", content: text }
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.1,
            max_tokens: 80
        });
        return `[Context]: ${res.choices[0].message.content}`;
    } catch (e) {
        return text.substring(0, 200);
    }
}

// --- 5. MESSAGE CHUNKER ---
async function sendLongResponse(ctx, chatId, statusMsgId, fullText) {
    const MAX = 4000;
    if (fullText.length <= MAX) {
        return ctx.telegram.editMessageText(chatId, statusMsgId, undefined, fullText, { parse_mode: 'Markdown' })
            .catch(() => ctx.telegram.editMessageText(chatId, statusMsgId, undefined, fullText));
    }
    const chunks = fullText.match(/[\s\S]{1,4000}/g) || [];
    await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, chunks[0]);
    for (let i = 1; i < chunks.length; i++) await ctx.telegram.sendMessage(chatId, chunks[i]);
}

// --- 6. CORE LOGIC ---
bot.command('reset', (ctx) => {
    chatMemory.set(ctx.chat.id, []);
    ctx.reply("🧹 **Workspace Cleared.** Memory is fresh.");
});

bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const chatId = ctx.chat.id;
    const botId = ctx.botInfo.id;

    // Focused Group logic
    if (ctx.chat.type !== 'private') {
        const isReplyToMe = ctx.message.reply_to_message?.from?.id === botId;
        const mentionsMe = userText.toLowerCase().includes('codebot');
        if (!isReplyToMe && !mentionsMe) return;
    }

    if (!chatMemory.has(chatId)) chatMemory.set(chatId, []);
    const history = chatMemory.get(chatId);

    const statusMsg = await ctx.reply("⚡ Thinking...", { reply_to_message_id: ctx.message.message_id });

    try {
        const chatCompletion = await requestWithRetry({
            messages: [
                { role: "system", content: SYSTEM_INSTRUCTION },
                ...history,
                { role: "user", content: userText }
            ],
            model: MODEL_NAME
        });

        let finalAnswer = chatCompletion.choices[0].message.content;

        // Screenshot Interceptor (Thum.io Fallback)
        const ssMatch = finalAnswer.match(/\[SCREENSHOT:(https?:\/\/[^\s\]]+)\]/);
        if (ssMatch) {
            const url = ssMatch[1];
            const ssUrl = `https://image.thum.io/get/width/1200/crop/900/noanimate/${url}`;
            await ctx.replyWithPhoto({ url: ssUrl }, { caption: `📸 Screenshot: ${url}`, reply_to_message_id: ctx.message.message_id });
            finalAnswer = finalAnswer.replace(ssMatch[0], "*(Screenshot sent above)*");
        }

        await sendLongResponse(ctx, chatId, statusMsg.message_id, finalAnswer);

        // Advanced Memory Management
        const userMem = userText.length > 500 ? await summarizeForMemory(userText) : userText;
        const botMem = await summarizeForMemory(finalAnswer);
        
        history.push({ role: "user", content: userMem });
        history.push({ role: "assistant", content: botMem });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

    } catch (error) {
        console.error(error);
        ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, `❌ **System Error:** ${error.message}`);
    }
});

bot.launch().then(() => console.log("✅ CodeBot Pro is polling..."));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
