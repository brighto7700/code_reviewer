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
const MODEL_NAME = "llama-3.3-70b-versatile";

// --- 3. MEMORY SETUP ---
// This stores the recent chat history keyed by Chat ID
const chatMemory = new Map();
const MAX_HISTORY = 6; // Remembers the last 3 pairs of questions/answers

// --- 4. MESSAGE CHUNKER (For Large Code Responses) ---
async function sendLongResponse(ctx, chatId, statusMsgId, fullText) {
    const MAX_LENGTH = 4000;
    
    // If it's short enough, send normally with Markdown formatting
    if (fullText.length <= MAX_LENGTH) {
        try {
            await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, fullText, { parse_mode: 'Markdown' });
        } catch (e) {
            // Fallback: If Markdown has unclosed tags from the AI, send as plain text so it doesn't crash
            await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, fullText);
        }
        return;
    }

    // If it's massive, split it by line so we don't cut words in half
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

    // Edit the first status message with part 1
    await ctx.telegram.editMessageText(chatId, statusMsgId, undefined, chunks[0]);
    
    // Send the rest of the chunks as follow-up messages
    for (let i = 1; i < chunks.length; i++) {
        await ctx.telegram.sendMessage(chatId, chunks[i]);
    }
}

// --- 5. TELEGRAM BOT LOGIC ---
bot.start((ctx) => {
    // Clear memory on /start so they can start fresh
    chatMemory.set(ctx.chat.id, []);
    ctx.reply("🧠 **I am CodeBot (Smart Mode)**\n\nNo commands needed! Just talk to me naturally. I will remember our current conversation!", { parse_mode: 'Markdown' });
});

bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const chatId = ctx.chat.id;
    const botUsername = ctx.botInfo.username;

    // Determine if the bot should reply
    let shouldReply = false;
    if (ctx.chat.type === 'private') shouldReply = true;
    else if (userText.includes(`@${botUsername}`) || userText.toLowerCase().includes('codebot')) shouldReply = true;
    else if (ctx.message.reply_to_message && ctx.message.reply_to_message.from.id === ctx.botInfo.id) shouldReply = true;

    if (!shouldReply) return;

    // Grab or create memory for this user
    if (!chatMemory.has(chatId)) chatMemory.set(chatId, []);
    const history = chatMemory.get(chatId);

    // Handle Code Context replies
    let repliedCode = "";
    let contextStatus = "Thinking...";
    let targetMsgId = ctx.message.message_id;

    if (ctx.message.reply_to_message) {
        repliedCode = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || "";
        targetMsgId = ctx.message.reply_to_message.message_id;
        if (repliedCode) contextStatus = "Scanning context...";
    }

    // Build the AI payload using the memory history
    const messagesPayload = [
        { role: "system", content: "You are CodeBot, an expert senior software engineer and code reviewer." },
        ...history // Inject previous conversation here!
    ];
    
    // Inject the new message and context
    let newPrompt = userText;
    if (repliedCode) {
        newPrompt = `HERE IS THE CODE CONTEXT:\n\`\`\`\n${repliedCode}\n\`\`\`\n\nUser Question: ${userText}`;
    }
    messagesPayload.push({ role: "user", content: newPrompt });

    try {
        const statusMsg = await ctx.reply(`⚡ ${contextStatus}`, { reply_to_message_id: targetMsgId });
        
        // Call Groq API
        const chatCompletion = await groq.chat.completions.create({
            messages: messagesPayload,
            model: MODEL_NAME,
            temperature: 0.6
        });

        const botResponse = chatCompletion.choices[0].message.content;
        
        // Save this turn to memory!
        history.push({ role: "user", content: newPrompt });
        history.push({ role: "assistant", content: botResponse });
        
        // Trim memory if it gets too long to save token costs
        if (history.length > MAX_HISTORY) {
            history.splice(0, history.length - MAX_HISTORY);
        }

        // Send response using our new chunking safety net
        await sendLongResponse(ctx, chatId, statusMsg.message_id, botResponse);

    } catch (error) {
        console.error("Groq API Error:", error);
        ctx.reply("❌ An error occurred generating a response.");
    }
});

// --- 6. LAUNCH THE BOT ---
bot.launch().then(() => console.log(`✅ CodeBot is actively polling!`));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
