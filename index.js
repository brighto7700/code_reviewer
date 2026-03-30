const express = require('express');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');

// --- 1. HEALTH CHECK SERVER (For Pxxl App) ---
const app = express();

app.get('/', (req, res) => {
    res.status(200).send('CodeBot Node.js Server is Online!');
});

// Let Pxxl App assign the port, default to 8080 locally
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🌐 Express web server listening on port ${PORT}`);
});

// --- 2. CONFIGURATION & SETUP ---
const telegramToken = process.env.TELEGRAM_TOKEN;
const groqApiKey = process.env.GROQ_API_KEY;

if (!telegramToken || !groqApiKey) {
    console.error("❌ ERROR: Missing TELEGRAM_TOKEN or GROQ_API_KEY in Environment Variables.");
    process.exit(1);
}

const bot = new Telegraf(telegramToken);
const groq = new Groq({ apiKey: groqApiKey });
const MODEL_NAME = "llama-3.3-70b-versatile";

// --- 3. TELEGRAM BOT LOGIC ---
bot.start((ctx) => {
    ctx.reply("🧠 **I am CodeBot (Smart Mode)**\n\nNo commands needed! Just talk to me naturally.", { parse_mode: 'Markdown' });
});

bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const chatType = ctx.chat.type;
    const botUsername = ctx.botInfo.username;

    // Determine if the bot should reply based on chat type and mentions
    let shouldReply = false;
    if (chatType === 'private') {
        shouldReply = true;
    } else if (userText.includes(`@${botUsername}`) || userText.toLowerCase().includes('codebot')) {
        shouldReply = true;
    } else if (ctx.message.reply_to_message && ctx.message.reply_to_message.from.id === ctx.botInfo.id) {
        shouldReply = true;
    }

    if (!shouldReply) return;

    // Extract context if replying to another user's message
    let repliedCode = "";
    let contextStatus = "Thinking...";
    let targetMsgId = ctx.message.message_id;

    if (ctx.message.reply_to_message) {
        repliedCode = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || "";
        targetMsgId = ctx.message.reply_to_message.message_id;
        if (repliedCode) {
            contextStatus = "Scanning context...";
        }
    }

    // Build the AI prompt payload
    const messagesPayload = [
        { role: "system", content: "You are CodeBot, an expert senior software engineer and code reviewer." }
    ];
    
    if (repliedCode) {
        messagesPayload.push({ role: "user", content: `HERE IS THE CODE CONTEXT:\n\`\`\`\n${repliedCode}\n\`\`\`` });
    }
    messagesPayload.push({ role: "user", content: userText });

    try {
        // Send initial status message to show the bot is working
        const statusMsg = await ctx.reply(`⚡ ${contextStatus}`, { reply_to_message_id: targetMsgId });
        
        // Call Groq API
        const chatCompletion = await groq.chat.completions.create({
            messages: messagesPayload,
            model: MODEL_NAME,
            temperature: 0.6
        });

        const botResponse = chatCompletion.choices[0].message.content;
        
        // Edit status message with the actual AI response
        await ctx.telegram.editMessageText(
            ctx.chat.id, 
            statusMsg.message_id, 
            undefined, 
            botResponse, 
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error("Groq API Error:", error);
        ctx.reply("❌ An error occurred generating a response.");
    }
});

// --- 4. LAUNCH THE BOT ---
bot.launch().then(() => {
    console.log(`✅ CodeBot is actively polling on Node.js using ${MODEL_NAME}!`);
}).catch((err) => {
    console.error("❌ Failed to launch bot:", err);
});

// Enable graceful stop for server shutdowns
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
