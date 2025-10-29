// ✅ handlers/misc.js

// 🔹 Dedicated list function (for quick commands like "list emails")
export async function handleListEmails(message, db) {
  try {
    const rows = await db.all("SELECT alias, email FROM emails ORDER BY LOWER(alias)");
    if (rows.length === 0) {
      await message.reply("📭 No emails saved yet. Use 'save alias=email@example.com' to add some!");
      return;
    }

    let reply = "📧 **Saved Emails:**\n";
    rows.forEach(row => {
      reply += `• **${row.alias}**: ${row.email}\n`;
    });
    reply += `\nTotal: ${rows.length} entry${rows.length > 1 ? "ies" : "y"}.`;
    await message.reply(reply);
  } catch (err) {
    console.error("❌ Error listing emails:", err);
    await message.reply("⚠️ Failed to fetch saved emails. Please try again.");
  }
}

// 🔹 General-purpose handler for misc messages (fallbacks, AI replies, date queries, etc.)
export async function handleMisc(message, db, model, cleanPrompt, lowerPrompt, intent, score, addToHistory) {
  // Date query
  if (intent === "dateQuery" && score >= 2 && lowerPrompt.includes("date") && lowerPrompt.includes("today")) {
    const today = new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" });
    const reply = `Today's date is ${today}.`;
    await message.reply(reply);
    addToHistory(message.content, reply);
    return true;
  }

  // Fallback: ask Gemini to respond politely
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    try {
      const result = await model.generateContent(cleanPrompt);
      let reply = result.response.text().trim().replace(/[*_#`]+/g, "");
      const maxLength = 2000;
      if (reply.length > maxLength) reply = reply.substring(0, maxLength - 3) + "...";
      await message.reply(reply);
      addToHistory(message.content, reply);
      return true;
    } catch (error) {
      attempts++;
      if (error.status === 429 && attempts < maxAttempts) {
        const delay = Math.pow(2, attempts) * 1000;
        console.warn(`⚠️ Rate limit hit, retrying after ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
      } else {
        console.error("❌ Misc handler error:", error);
        await message.reply("⚠️ Something went wrong while replying.");
        return false;
      }
    }
  }
  return false;
}