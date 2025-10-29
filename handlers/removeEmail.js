import { getClosestAlias } from "../utils.js";

export async function handleRemoveEmail(message, db, cleanPrompt, lowerPrompt, intent, score, addToHistory) {
  if (intent !== "removeEmail" || score < 2) return false;
  
  const removeMatch = lowerPrompt.match(/(?:remove|delete)\s+((?:[a-z0-9._-]{2,}(?:\s+|\s*and\s+)*)+)/i);
  if (removeMatch) {
    const aliases = removeMatch[1].split(/[\s,;&]+|(?:\band\b)/i).map(a => a.trim()).filter(Boolean);
    console.log("Remove aliases:", aliases);
    let reply = "";
    let removedCount = 0;
    await db.run("BEGIN TRANSACTION");
    try {
      for (const alias of [...new Set(aliases)]) {
        const row = await db.get("SELECT alias, email FROM emails WHERE LOWER(alias) = LOWER(?)", [alias]);
        if (!row) {
          const closest = await getClosestAlias(alias, db);
          if (closest) {
            const changes = await db.run("DELETE FROM emails WHERE LOWER(alias) = LOWER(?)", [closest]);
            console.log(`DB changes for remove '${closest}' (assumed for '${alias}'):`, changes.changes);
            if (changes.changes > 0) {
              reply += `✅ Removed alias '${closest}' (assumed for '${alias}').\n`;
              removedCount++;
            } else {
              reply += `⚠️ Alias '${alias}' not found. Use 'list emails' to check.\n`;
            }
          } else {
            reply += `⚠️ Alias '${alias}' not found. Use 'list emails' to check.\n`;
          }
        } else {
          const changes = await db.run("DELETE FROM emails WHERE LOWER(alias) = LOWER(?)", [alias]);
          console.log(`DB changes for remove '${alias}':`, changes.changes);
          if (changes.changes > 0) {
            reply += `✅ Removed alias '${alias}'.\n`;
            removedCount++;
          } else {
            reply += `⚠️ Alias '${alias}' not found. Use 'list emails' to check.\n`;
          }
        }
      }
      await db.run("COMMIT");
      if (removedCount > 0) {
        reply += `\nRemoved ${removedCount} alias${removedCount > 1 ? 'es' : ''}.`;
      }
    } catch (dbError) {
      console.error("❌ DB error in remove transaction:", dbError);
      await db.run("ROLLBACK");
      reply += `⚠️ Error removing aliases. Try again.\n`;
    }
    await message.reply(reply.trim());
    addToHistory(message.content, reply.trim());
    return true;
  }
  return false;
}