const express = require('express');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');

// --- 1. HEALTH CHECK SERVER ---
const app = express();
app.get('/', (req, res) => res.status(200).send('CodeBot Node.js Server is Online!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🌐 Express web server listening on port ${PORT}`));

// --- 2. CONFIGURATION & SETUP ---
const telegramToken = process.env.TELEGRAM_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;

if (!telegramToken || !groqApiKey) {
    console.error("❌ ERROR: Missing TELEGRAM_TOKEN or GROQ_API_KEY.");
    process.exit(1);
}

const bot = new Telegraf(telegramToken);
const groq = new Groq({ apiKey: groqApiKey });

// Using Groq's compound system which has web search built-in natively
const MODEL_NAME = "groq/compound";

// --- 3. MEMORY SETUP ---
const chatMemory = new Map();
const MAX_HISTORY = 6; 

// --- 4. MESSAGE CHUNKER ---
async function sendLongResponse(ctx, chatId, statusMsgId, fullText) {
    const MAX_LENGTH = 4000;
    
    if (fullText.length <= MAX_LENGTH) {
        try {
            await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, fullText, { parse_mode: 'Markdown' });
        } catch (e) {
            await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, fullText);
        }
        return;
    }

    const chunks = [];
    let currentChunk = "";
    const lines = fullText.split('\n');

    for (const line of lines) {
        if ((currentChunk.length + line.length + 1) > MAX_LENGTH) {
            chunks.push(currentChunk);
            currentChunk = line + '\n';
        } else {
            currentChunk += line + '\n';
        }
    }
    if (currentChunk) chunks.push(currentChunk);

    await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
        await ctx.telegram.sendMessage(chatId, chunks[i]);
    }
}

// --- 5. MEMORY SUMMARIZER (Strict Mode) ---
async function summarizeForMemory(text) {
    if (text.length <= 50) return text;

    try {
        console.log("📝 Summarizing bot response to save memory...");
        const summaryResponse = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "You are a memory assistant. Summarize the following text in 1 concise sentence so the main AI remembers the core context." },
                { role: "user", content: text }
            ],
            model: "llama3-8b-8192", 
            temperature: 0.3,
            max_tokens: 150
        });
        
        return `[Summary]: ${summaryResponse.choices[0].message.content}`;
    } catch (error) {
        console.error("⚠️ Summary failed, falling back to truncation:", error.message);
        return text.substring(0, 500) + "\n...[Truncated]";
    }
}

// --- 6. TELEGRAM BOT LOGIC ---
bot.start((ctx) => {
    chatMemory.set(ctx.chat.id, []);
    ctx.reply("🧠 **I am CodeBot (Smart Mode)**\n\nNo commands needed! Just talk to me naturally. I can search the web automatically if you ask for live data!", { parse_mode: 'Markdown' });
});

bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const chatId = ctx.chat.id;
    const botUsername = ctx.botInfo.username;

    let shouldReply = false;
    if (ctx.chat.type === 'private') shouldReply = true;
    else if (userText.includes(`@${botUsername}`) || userText.toLowerCase().includes('codebot')) shouldReply = true;
    else if (ctx.message.reply_to_message && ctx.message.reply_to_message.from.id === ctx.botInfo.id) shouldReply = true;

    if (!shouldReply) return;

    if (!chatMemory.has(chatId)) chatMemory.set(chatId, []);
    const history = chatMemory.get(chatId);

    let repliedCode = "";
    let contextStatus = "Thinking...";
    let targetMsgId = ctx.message.message_id;

    if (ctx.message.reply_to_message) {
        repliedCode = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || "";
        targetMsgId = ctx.message.reply_to_message.message_id;
        if (repliedCode) contextStatus = "Scanning context...";
    }

    const messagesPayload = [
        { role: "system", content: "You are CodeBot, an expert senior software engineer. You have native web search capabilities. Provide helpful, accurate, and concise coding assistance." },
        ...history 
    ];
    
    let newPrompt = userText;
    if (repliedCode) {
        newPrompt = `HERE IS THE CODE CONTEXT:\n\`\`\`\n${repliedCode}\n\`\`\`\n\nUser Question: ${userText}`;
    }
    
    // We send the FULL prompt to Groq for the current answer
    messagesPayload.push({ role: "user", content: newPrompt });

    try {
        const statusMsg = await ctx.reply(`⚡ ${contextStatus}`, { reply_to_message_id: targetMsgId });
        
        const chatCompletion = await groq.chat.completions.create({
            messages: messagesPayload,
            model: MODEL_NAME,
            temperature: 0.6
        });

        const finalAnswer = chatCompletion.choices[0].message.content;

        // 1. Send the FULL response to the user immediately
        await sendLongResponse(ctx, chatId, statusMsg.message_id, finalAnswer);

        // 2. Protect memory from giant user code dumps (keep max 2000 chars of user input)
        const safeUserPrompt = newPrompt.length > 2000 
            ? newPrompt.substring(0, 2000) + "\n...[User input truncated for memory limit]" 
            : newPrompt;

        // 3. Silently summarize the bot's answer in the background
        const memorySafeAnswer = await summarizeForMemory(finalAnswer);

        // 4. Update memory with safe sizes for BOTH user and assistant
        history.push({ role: "user", content: safeUserPrompt });
        history.push({ role: "assistant", content: memorySafeAnswer });
        
        // 5. Keep array size in check
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

    } catch (error) {
        console.error("API Error:", error);
        ctx.reply(`❌ **SYSTEM ERROR:**\n\`\`\`text\n${error.message || "Unknown API Error"}\n\`\`\``, { parse_mode: 'Markdown' });
    }
});

// --- 7. LAUNCH THE BOT ---
bot.launch().then(() => console.log(`✅ CodeBot is actively polling!`));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
