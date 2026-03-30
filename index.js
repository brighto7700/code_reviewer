const express = require('express');
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const { search } = require('duck-duck-scrape'); 

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

// --- 5. THE WEB SEARCH TOOL ---
const tools = [
    {
        type: "function",
        function: {
            name: "search_web",
            description: "Searches the web using DuckDuckGo to find real-time information, articles, and news. Use this when the user asks for links, current events, or facts you aren't sure about.",
            parameters: {
                type: "object",
                properties: {
                    query: { 
                        type: "string", 
                        description: "The search query (e.g., 'latest react projects dev.to')" 
                    }
                },
                required: ["query"]
            }
        }
    }
];

// --- 6. TELEGRAM BOT LOGIC ---
bot.start((ctx) => {
    chatMemory.set(ctx.chat.id, []);
    ctx.reply("🧠 **I am CodeBot (Smart Mode)**\n\nNo commands needed! Just talk to me naturally. I can now search the web for you!", { parse_mode: 'Markdown' });
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
        { role: "system", content: "You are CodeBot, an expert software engineer. You have access to the internet. If a user asks for articles, links, or current facts, ALWAYS use the search_web tool." },
        ...history 
    ];
    
    let newPrompt = userText;
    if (repliedCode) {
        newPrompt = `HERE IS THE CODE CONTEXT:\n\`\`\`\n${repliedCode}\n\`\`\`\n\nUser Question: ${userText}`;
    }
    messagesPayload.push({ role: "user", content: newPrompt });

    try {
        const statusMsg = await ctx.reply(`⚡ ${contextStatus}`, { reply_to_message_id: targetMsgId });
        
        const chatCompletion = await groq.chat.completions.create({
            messages: messagesPayload,
            model: MODEL_NAME,
            temperature: 0.6,
            tools: tools,
            tool_choice: "auto"
        });

        const responseMessage = chatCompletion.choices[0].message;

        if (responseMessage.tool_calls) {
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, "🔍 Searching the live web...");
            
            messagesPayload.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === "search_web") {
                    const args = JSON.parse(toolCall.function.arguments);
                    console.log(`AI is searching DuckDuckGo for: ${args.query}`);
                    
                    const searchResults = await search(args.query);
                    const formattedResults = searchResults.results.slice(0, 5).map(res => 
                        `Title: ${res.title}\nURL: ${res.url}\nDescription: ${res.description}`
                    ).join('\n\n');

                    messagesPayload.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        name: "search_web",
                        content: formattedResults
                    });
                }
            }

            const secondResponse = await groq.chat.completions.create({
                messages: messagesPayload,
                model: MODEL_NAME,
                temperature: 0.6
            });

            const finalAnswer = secondResponse.choices[0].message.content;
            
            history.push({ role: "user", content: newPrompt });
            history.push({ role: "assistant", content: finalAnswer });
            if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

            await sendLongResponse(ctx, chatId, statusMsg.message_id, finalAnswer);

        } else {
            const botResponse = responseMessage.content;
            
            history.push({ role: "user", content: newPrompt });
            history.push({ role: "assistant", content: botResponse });
            if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

            await sendLongResponse(ctx, chatId, statusMsg.message_id, botResponse);
        }

    } catch (error) {
        console.error("API Error:", error);
        ctx.reply("❌ An error occurred generating a response.");
    }
});

// --- 7. LAUNCH THE BOT ---
bot.launch().then(() => console.log(`✅ CodeBot is actively polling!`));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
