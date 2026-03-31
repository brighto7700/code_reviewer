const express = require('express');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');

// --- 1. HEALTH CHECK SERVER ---
// Keeps the bot alive on cloud hosting platforms
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
// Bypasses Telegram's 4000 character limit by splitting long messages
async function sendLongResponse(ctx, chatId, statusMsgId, fullText) {
    const MAX_LENGTH = 4000;
    
    // If it's short enough, just edit the thinking message
    if (fullText.length <= MAX_LENGTH) {
        try {
            await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, fullText, { parse_mode: 'Markdown' });
        } catch (e) {
            // Fallback if Markdown parsing fails
            await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, fullText);
        }
        return;
    }

    // If it's too long, split it up intelligently by lines
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

    // Edit the first status message, then send the rest as new messages
    await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
        await ctx.telegram.sendMessage(chatId, chunks[i]);
    }
}

// --- 5. TELEGRAM BOT LOGIC ---
bot.start((ctx) => {
    chatMemory.set(ctx.chat.id, []);
    ctx.reply("🧠 **I am CodeBot (Smart Mode)**\n\nNo commands needed! Just talk to me naturally. I can search the web automatically if you ask for live data!", { parse_mode: 'Markdown' });
});

bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const chatId = ctx.chat.id;
    const botUsername = ctx.botInfo.username;

    // Determine if the bot should reply based on chat type and mentions
    let shouldReply = false;
    if (ctx.chat.type === 'private') shouldReply = true;
    else if (userText.includes(`@${botUsername}`) || userText.toLowerCase().includes('codebot')) shouldReply = true;
    else if (ctx.message.reply_to_message && ctx.message.reply_to_message.from.id === ctx.botInfo.id) shouldReply = true;

    if (!shouldReply) return;

    // Initialize or fetch memory for this specific chat
    if (!chatMemory.has(chatId)) chatMemory.set(chatId, []);
    const history = chatMemory.get(chatId);

    let repliedCode = "";
    let contextStatus = "Thinking...";
    let targetMsgId = ctx.message.message_id;

    // Check if the user is replying to a specific message to provide code context
    if (ctx.message.reply_to_message) {
        repliedCode = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || "";
        targetMsgId = ctx.message.reply_to_message.message_id;
        if (repliedCode) contextStatus = "Scanning context...";
    }

    // Build the payload for the AI
    const messagesPayload = [
        { role: "system", content: "You are CodeBot, an expert senior software engineer. You have native web search capabilities. Provide helpful, accurate, and concise coding assistance." },
        ...history 
    ];
    
    let newPrompt = userText;
    if (repliedCode) {
        newPrompt = `HERE IS THE CODE CONTEXT:\n\`\`\`\n${repliedCode}\n\`\`\`\n\nUser Question: ${userText}`;
    }
    messagesPayload.push({ role: "user", content: newPrompt });

    try {
        // Let the user know the bot is processing
        const statusMsg = await ctx.reply(`⚡ ${contextStatus}`, { reply_to_message_id: targetMsgId });
        
        // Simple, clean API call. The model handles search automatically!
        const chatCompletion = await groq.chat.completions.create({
            messages: messagesPayload,
            model: MODEL_NAME,
            temperature: 0.6
        });

        const finalAnswer = chatCompletion.choices[0].message.content;
            
        // Update memory
        history.push({ role: "user", content: newPrompt });
        history.push({ role: "assistant", content: finalAnswer });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

        // Send the final result back to Telegram
        await sendLongResponse(ctx, chatId, statusMsg.message_id, finalAnswer);

    } catch (error) {
        console.error("API Error:", error);
        ctx.reply(`❌ **SYSTEM ERROR:**\n\`\`\`text\n${error.message || "Unknown API Error"}\n\`\`\``, { parse_mode: 'Markdown' });
    }
});

// --- 6. LAUNCH THE BOT ---
bot.launch().then(() => console.log(`✅ CodeBot is actively polling!`));

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
