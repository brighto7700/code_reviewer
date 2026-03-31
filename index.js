const express = require('express');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');

const app = express();
app.get('/', (req, res) => res.status(200).send('CodeBot is Online!'));
app.listen(process.env.PORT || 8080);

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_NAME = "groq/compound";
const chatMemory = new Map();
const MAX_HISTORY = 4; 

// --- 1. RETRY WRAPPER (Fixes the 429 error) ---
async function requestWithRetry(payload, retries = 2) {
    try {
        return await groq.chat.completions.create(payload);
    } catch (error) {
        if (error.status === 429 && retries > 0) {
            // Extract wait time from error or default to 4 seconds
            const waitTime = error.message.match(/(\d+\.\d+)s/) ? parseFloat(error.message.match(/(\d+\.\d+)s/)[1]) * 1000 : 4000;
            console.log(`⚠️ Rate limited. Retrying in ${waitTime/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime + 500)); 
            return requestWithRetry(payload, retries - 1);
        }
        throw error;
    }
}

// --- 2. BACKGROUND SUMMARIZER ---
async function summarizeForMemory(text) {
    if (!text || text.length <= 40) return text || "";
    try {
        const res = await requestWithRetry({
            messages: [
                { role: "system", content: "Summarize into ONE short sentence for AI memory." },
                { role: "user", content: text }
            ],
            model: "llama-3.1-8b-instant",
            temperature: 0.1,
            max_tokens: 60
        });
        return `[Context]: ${res.choices[0].message.content}`;
    } catch (e) { return text.substring(0, 200); }
}

// --- 3. MESSAGE CHUNKER ---
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

// --- 4. BOT LOGIC ---
bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const chatId = ctx.chat.id;
    const botId = ctx.botInfo.id;

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
                { role: "system", content: "You are CodeBot. Use built-in search for live data. Format screenshots as: [SCREENSHOT:https://url]" },
                ...history,
                { role: "user", content: userText }
            ],
            model: MODEL_NAME
        });

        let finalAnswer = chatCompletion.choices[0].message.content;

        // Screenshot Detection
        const ssMatch = finalAnswer.match(/\[SCREENSHOT:(https?:\/\/[^\s\]]+)\]/);
        if (ssMatch) {
            const url = ssMatch[1];
            const ssUrl = `https://image.thum.io/get/width/1200/crop/900/noanimate/${url}`;
            await ctx.replyWithPhoto({ url: ssUrl }, { caption: `📸 Captured: ${url}`, reply_to_message_id: ctx.message.message_id });
            finalAnswer = finalAnswer.replace(ssMatch[0], "(Screenshot sent above)");
        }

        await sendLongResponse(ctx, chatId, statusMsg.message_id, finalAnswer);

        // Update Memory
        const userMem = userText.length > 500 ? await summarizeForMemory(userText) : userText;
        const botMem = await summarizeForMemory(finalAnswer);
        history.push({ role: "user", content: userMem });
        history.push({ role: "assistant", content: botMem });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

    } catch (error) {
        console.error(error);
        ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, `❌ Rate Limit: I'm cooling down for a moment. Try again in a few seconds.`);
    }
});

bot.launch();
