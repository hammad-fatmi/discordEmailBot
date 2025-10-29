import { emailRegex } from "../utils.js";

export async function handleSaveEmail(message, db, cleanPrompt, lowerPrompt, intent, score, addToHistory) {
  if (intent !== "saveEmail" || score < 2) return false;
  
  console.log("Clean prompt:", cleanPrompt);
  // Try regex first
  const saveMatches = cleanPrompt.matchAll(/(?:save|add|store|set)\s+([a-z0-9._-]{2,})\s*=\s*([^\s;]+@[^@]+\.[a-z]{2,})/gi);
  let savePairs = Array.from(saveMatches);
  console.log("Regex save matches:", savePairs.map(m => ({ alias: m[1], email: m[2] })));
  
  // Fallback to split-based parsing
  if (savePairs.length === 0 || savePairs.length < cleanPrompt.split('=').length - 1) {
    console.log("Falling back to split-based parsing");
    const parts = cleanPrompt.split(/\s+/).filter(Boolean);
    savePairs = [];
    let i = 0;
    while (i < parts.length) {
      if (/(save|add|store|set)/i.test(parts[i])) {
        i++;
        while (i < parts.length && parts[i].includes('=')) {
          const [alias, email] = parts[i].split('=');
          if (alias && email && emailRegex.test(email)) {
            savePairs.push([null, alias, email]);
          }
          i++;
        }
      } else {
        i++;
      }
    }
    console.log("Split save matches:", savePairs.map(p => ({ alias: p[1], email: p[2] })));
  }

  if (savePairs.length > 0) {
    let reply = "";
    for (const [, alias, email] of savePairs) {
      if (!emailRegex.test(email)) {
        reply += `⚠️ Invalid email for '${alias}': ${email}\n`;
        continue;
      }
      try {
        const changes = await db.run("INSERT OR REPLACE INTO emails (alias, email) VALUES (?, ?)", [alias, email]);
        console.log(`DB changes for save '${alias}':`, changes.changes);
        reply += `✅ Saved alias '${alias}' = ${email}.\n`;
      } catch (dbError) {
        console.error(`❌ DB error for save '${alias}':`, dbError);
        reply += `⚠️ Error saving '${alias}' = ${email}. Try a different alias.\n`;
      }
    }
    await message.reply(reply.trim() || "⚠️ No valid aliases/emails found. Use 'save alias=email'.");
    addToHistory(message.content, reply.trim());
    return true;
  } else {
    const reply = "⚠️ No valid aliases/emails found. Use 'save alias=email'.";
    await message.reply(reply);
    addToHistory(message.content, reply);
    return true;
  }
}