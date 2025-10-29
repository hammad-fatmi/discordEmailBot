import { handleSendEmail } from "./handlers/sendEmail.js";
import { handleSaveEmail } from "./handlers/saveEmail.js";
import { handleRemoveEmail } from "./handlers/removeEmail.js";
import { handleListEmails } from "./handlers/misc.js";

/**
 * Handles all incoming Discord messages intelligently.
 * Uses AI (Gemini) for natural-language intent detection,
 * with a few safe rule-based short-circuits for admin-type commands.
 */
export async function handleMessage(message, db, model, transporter, pendingConfirmations) {
  if (message.author.bot) return;

  // 🚫 Ignore confirmation replies (“yes” or “no”) — handled inside sendEmail.js
  if (["yes", "no"].includes(message.content.trim().toLowerCase())) return;

  const cleanPrompt = message.content.trim();
  const lower = cleanPrompt.toLowerCase();

  // 🧩 1️⃣ Quick bypass — handle "list emails" or "show emails" safely (no AI)
  if (
    lower === "list emails" ||
    lower === "show email list" ||
    lower.includes("show saved emails") ||
    lower.includes("list saved emails") ||
    lower.includes("display emails")
  ) {
    await handleListEmails(message, db);
    return;
  }

  // 🧩 2️⃣ Add-to-history helper
  const addToHistory = async (userMsg, botReply) => {
    console.log(`💬 ${message.author.username}: ${userMsg}`);
    console.log(`🤖 Bot: ${botReply}`);
  };

  // 🧠 3️⃣ AI-based intent detection
  const intentPrompt = `
You are an intent detection assistant.
Analyze this Discord message and decide the user's intent.

Message: "${cleanPrompt}"

Return only a JSON object like this:
{
  "intent": "sendEmail" | "saveEmail" | "removeEmail" | "listEmails" | "unknown",
  "score": 1–5
}

Rules:
- "sendEmail" → user wants to email or message someone (send, mail, tell, inform, notify, email, message, etc.)
- "saveEmail" → user wants to save or add a new alias (save, add, store, register)
- "removeEmail" → user wants to delete or forget an alias (remove, delete, forget)
- "listEmails" → user wants to view saved aliases (list, show, display)
- "unknown" → anything else
`;

  let intent = "unknown";
  let score = 0;

  try {
    const result = await model.generateContent(intentPrompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    intent = parsed.intent || "unknown";
    score = parsed.score || 0;
  } catch (err) {
    console.error("❌ Gemini intent detection error:", err);
    intent = "unknown";
  }

  console.log(`🧭 Detected intent: ${intent} (score: ${score})`);

  // 🧩 4️⃣ Route to correct handler
  try {
    switch (intent) {
      case "sendEmail":
        await handleSendEmail(
          message,
          db,
          model,
          transporter,
          pendingConfirmations,
          cleanPrompt,
          lower,
          intent,
          score,
          addToHistory
        );
        break;

      case "saveEmail":
        await handleSaveEmail(
          message,
          db,
          cleanPrompt,
          lower,
          intent,
          score,
          addToHistory
        );
        break;

      case "removeEmail":
        await handleRemoveEmail(
          message,
          db,
          cleanPrompt,
          lower,
          intent,
          score,
          addToHistory
        );
        break;

      case "listEmails":
        await handleListEmails(message, db);
        break;

      default: {
        // 🗣️ CASUAL CONVERSATION HANDLER
        const casualResponses = {
          hello: "👋 Hey there! How can I help with your emails today?",
          hi: "Hi! 😊 Ready to send or save an email?",
          hey: "Hey! 👋 What email task would you like to do?",
          thanks: "You're very welcome! 💌",
          thankyou: "You're very welcome! 💌",
          "how are you": "I'm great and ready to handle your emails! How about you?",
          "who are you": "I'm your friendly email assistant bot 🤖",
          "what can you do": "I can help you send, save, or remove emails — just tell me what you’d like!",
          help:
            "Sure! You can try:\n• send email to ali (hello)\n• save ali=ali@example.com\n• remove ali\n• list emails",
        };

        const userMsg = cleanPrompt.toLowerCase();
        const foundKey = Object.keys(casualResponses).find((key) =>
          userMsg.includes(key)
        );

        if (foundKey) {
          const reply = casualResponses[foundKey];
          await message.reply(reply);
          await addToHistory(cleanPrompt, reply);
          return;
        }

        // 🧩 Default fallback (if nothing matched)
        const reply =
          "🤖 Sorry, I didn’t quite understand that. You can try:\n" +
          "• send email to ali (hello)\n" +
          "• save ali=ali@example.com\n" +
          "• remove ali\n" +
          "• list emails";
        await message.reply(reply);
        await addToHistory(cleanPrompt, reply);
        break;
      }
    }
  } catch (err) {
    console.error("❌ Error in handleMessage routing:", err);
    const reply = "⚠️ Something went wrong while processing your message.";
    await message.reply(reply);
    await addToHistory(cleanPrompt, reply);
  }
}