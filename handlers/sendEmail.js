import { emailRegex, getSavedAliasesMap, resolveAliasesToEmails, getClosestAlias } from "../utils.js";
import fs from 'fs';

export async function handleSendEmail(message, db, model, transporter, pendingConfirmations, cleanPrompt, lowerPrompt, intent, score, addToHistory) {
  if (!(intent === "sendEmail" || score >= 0.5)) return false;

  const defaultSenderName = "HammadFatmi";
  const savedMap = await getSavedAliasesMap(db);
  const savedAliases = [...savedMap.keys()];

  let excludes = [], to = [], cc = [], bcc = [], sender = defaultSenderName, messageBody = '', language = "English";
  let attachments = [];

  const parsePrompt = `
You are an intelligent email-sending assistant. ALWAYS interpret the user's message as a command to SEND an email, even if it is polite, indirect, or phrased as a question.
User message: """${cleanPrompt}"""

INSTRUCTIONS (READ CAREFULLY):
- ALWAYS output ONLY a valid JSON object and NOTHING else (no markdown, no commentary).
- The JSON must exactly follow this schema:
{
  "excludes": [],
  "to": [],
  "cc": [],
  "bcc": [],
  "sender": "",
  "body": "",
  "language": "English",
  "attachments": []
}
- "to", "cc", "bcc", "excludes", and "attachments" are arrays of aliases or file references (e.g., the names of files attached in the Discord message like "Combined_Receipts.pdf").
- "sender" is the display name to appear in the email's From (use default if not present).
- "body" is the message content to include in the email.
- "language" is the language to write the email in; detect from message (e.g., "in Urdu" → "Urdu"), default "English". Supported: English, Urdu, Korean, Hindi, Arabic, French, Mandarin, Malayalam.
- Use "everyone" for all recipients.
- If the message mentions an attachment (e.g., "attached pdf", "here is the file") and a file is attached in the Discord message, list the attached file name(s) in "attachments" (e.g., ["Combined_Receipts.pdf"]). If no file is attached but "attached" is mentioned, note it but leave "attachments" empty.
- If unsure about an alias or file, include it anyway for validation later.

Valid aliases (from DB): ${savedAliases.join(', ')} or "everyone".

Return ONLY valid JSON.
`;

  try {
    const result = await model.generateContent(parsePrompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    excludes = parsed.excludes || [];
    to = parsed.to || [];
    cc = parsed.cc || [];
    bcc = parsed.bcc || [];
    sender = parsed.sender || defaultSenderName;
    messageBody = parsed.body || '';
    language = parsed.language || "English";
    attachments = parsed.attachments || [];
    console.log("📄 Parsed attachments from prompt:", attachments); // Debug log
  } catch (e) {
    console.error("❌ Gemini parsing error in sendEmail:", e);
    if (lowerPrompt.includes("everyone")) to = ["everyone"];
    else to = savedAliases.filter(a => lowerPrompt.includes(a.toLowerCase()));
    language = "English";
    if (lowerPrompt.includes("attached") || lowerPrompt.includes("file")) {
      console.log("📄 Attachment mentioned but no file parsed.");
    }
  }

  // --- Handle Discord attachments ---
  const discordAttachments = message.attachments.size > 0 ? Array.from(message.attachments.values()).map(a => a.name) : [];
  console.log("📎 Discord attachments:", discordAttachments);
  if (discordAttachments.length > 0) {
    attachments = discordAttachments; // Use attached file names
    console.log("📄 Using Discord attachments:", attachments);
  } else if (attachments.length === 0 && (lowerPrompt.includes("attached") || lowerPrompt.includes("file"))) {
    message.reply("⚠️ No file attached in Discord message. Please attach a file to send.");
    return true;
  }

  // --- Download attachments ---
  const attachmentPaths = [];
  if (discordAttachments.length > 0) {
    for (const attachment of message.attachments.values()) {
      const url = attachment.url;
      const tempPath = `temp_${attachment.name}`;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));
        attachmentPaths.push(tempPath);
        console.log(`📄 Downloaded attachment: ${tempPath}`);
      } catch (err) {
        console.error(`❌ Error downloading attachment ${attachment.name}: ${err.message}`);
        message.reply(`⚠️ Failed to download ${attachment.name}.`);
      }
    }
  }

  // --- Alias and attachment correction ---
  const correctAliases = async (aliases) => {
    const corrected = [];
    for (const alias of aliases) {
      if (alias.toLowerCase() === 'everyone') {
        corrected.push('everyone');
        continue;
      }
      const row = await db.get("SELECT alias FROM emails WHERE LOWER(alias) = LOWER(?)", [alias]);
      if (row) corrected.push(row.alias);
      else {
        const closest = await getClosestAlias(alias, db);
        if (closest) {
          await message.reply(`Assuming '${closest}' for '${alias}'.`);
          corrected.push(closest);
        }
      }
    }
    return [...new Set(corrected)];
  };

  excludes = await correctAliases(excludes);
  to = await correctAliases(to);
  cc = await correctAliases(cc);
  bcc = await correctAliases(bcc);

  // Validate aliases
  const validateAliases = (aliases) => {
    const invalid = aliases.filter(a => a !== 'everyone' && !savedAliases.includes(a.toLowerCase()));
    if (invalid.length > 0) {
      throw new Error(`Invalid recipient(s): ${invalid.join(', ')}. Valid: ${savedAliases.join(', ') || 'none'} or 'everyone'.`);
    }
    return aliases;
  };

  let toResolved = [], ccResolved = [], bccResolved = [];
  try {
    const allAliases = (await db.all("SELECT alias, email FROM emails")).map(r => ({ alias: r.alias.toLowerCase(), email: r.email }));

    if (to.includes('everyone') || (to.length === 0 && excludes.length > 0)) toResolved = allAliases;
    else toResolved = await resolveAliasesToEmails(validateAliases(to), savedMap, async (msg) => await message.reply(msg), db);

    ccResolved = await resolveAliasesToEmails(validateAliases(cc), savedMap, async (msg) => await message.reply(msg), db);
    bccResolved = await resolveAliasesToEmails(validateAliases(bcc), savedMap, async (msg) => await message.reply(msg), db);

    const excludeSet = new Set(excludes.map(e => e.toLowerCase()));
    toResolved = toResolved.filter(r => !excludeSet.has(r.alias.toLowerCase()));
    ccResolved = ccResolved.filter(r => !excludeSet.has(r.alias.toLowerCase()));
    bccResolved = ccResolved.filter(r => !excludeSet.has(r.alias.toLowerCase()));
  } catch (err) {
    const reply = `⚠️ ${err.message}`;
    await message.reply(reply);
    addToHistory(message.content, reply);
    return true;
  }

  const missing = [];
  for (const r of [...toResolved, ...ccResolved, ...bccResolved]) {
    if (!r.email) missing.push(r.alias);
  }
  if (missing.length > 0) {
    const reply = `⚠️ Alias${missing.length > 1 ? 'es' : ''} not found: ${missing.join(', ')}. Use 'list emails' or 'save alias=email'.`;
    await message.reply(reply);
    addToHistory(message.content, reply);
    return true;
  }

  const toEmails = toResolved.map(r => r.email);
  const ccEmails = ccResolved.map(r => r.email);
  const bccEmails = bccResolved.map(r => r.email);
  const toAliases = toResolved.map(r => r.alias);
  const ccAliases = ccResolved.map(r => r.alias);
  const bccAliases = bccResolved.map(r => r.alias);

  if (toEmails.length === 0 && ccEmails.length === 0 && bccEmails.length === 0) {
    const reply = "⚠️ No valid recipients found after exclusions.";
    await message.reply(reply);
    addToHistory(message.content, reply);
    return true;
  }

  // --- Email composition ---
  const totalRecipients = toEmails.length + ccEmails.length + bccEmails.length;
  const greeting = totalRecipients > 10 ? `Dear All,` :
    toAliases.length === 1 ? `Dear ${toAliases[0]},` :
      toAliases.length > 1 ? `Dear ${toAliases.join(' and ')},` : `Hello,`;

  const excludeNote = excludes.length > 0 ? `\n\nNote: Excluded ${excludes.join(', ')}.` : '';
  const emailPrompt = `Write a polite, professional email in the ${language} language from "${sender}" saying: "${messageBody}". Start with "${greeting}", end with "Sincerely, ${sender}". Include note: "${excludeNote}".`;

  let emailBody = "";
  try {
    const result = await model.generateContent(emailPrompt);
    emailBody = result.response.text().trim().replace(/[*_#`]+/g, "");
  } catch {
    emailBody = `${greeting}\n\n${messageBody}${excludeNote}\n\nSincerely,\n${sender}`;
  }

  // --- Generate a meaningful subject with natural language support ---
  const subject = `Important Update: ${emailBody.split('\n')[0].trim().substring(0, 250)}`.trim();

  // --- ⚠️ Confirmation before sending (using pendingConfirmations) ---
  const previewBody = emailBody.length > 1500 ? emailBody.substring(0, 1500) + "..." : emailBody;
  const confirmationMessage = await message.reply(
    `⚠️ **Confirm sending email**:\n**To:** ${toAliases.join(", ") || "(none)"}\n**CC:** ${ccAliases.join(", ") || "(none)"}\n**BCC:** ${bccAliases.join(", ") || "(none)"}\n${
      attachmentPaths.length > 0 || discordAttachments.length > 0 ? `\n**Attachments:** ${discordAttachments.join(", ")}` : '\n**Attachments:** (none detected)'
    }\n\n**Subject:** ${subject}\n\n**Body Preview:**\n${previewBody}\n\nReply **yes** to send or **no** to cancel.`
  );

  const data = {
    toEmails,
    ccEmails,
    bccEmails,
    toAliases,
    ccAliases,
    bccAliases,
    subject,
    emailBody,
    sender,
    language,
    attachments: attachmentPaths,
  };

  const sendEmailFunc = async (data) => {
    const { toEmails, ccEmails, bccEmails, subject, emailBody, sender, attachments } = data;
    if (process.env.GMAIL_ADDRESS && process.env.GMAIL_APP_PASSWORD) {
      const mailOptions = {
        from: `${sender} <${process.env.GMAIL_ADDRESS}>`,
        to: toEmails.join(", "),
        cc: ccEmails.join(", "),
        bcc: bccEmails.join(", "),
        subject,
        text: emailBody,
        attachments: attachments.map(file => ({
          filename: file.split('/').pop(),
          path: file,
        })),
      };

      const info = await transporter.sendMail(mailOptions);
      console.log("✅ Email sent:", info.response);
      // Clean up temporary files
      attachments.forEach(file => fs.unlinkSync(file));
    } else {
      throw new Error("Gmail credentials missing.");
    }
  };

  const timer = setTimeout(() => {
    pendingConfirmations.delete(message.author.id);
    message.reply("⌛ No response in 30s — email cancelled.");
    attachments.forEach(file => fs.unlinkSync(file)); // Clean up on timeout
  }, 30000);

  pendingConfirmations.set(message.author.id, { data, timer, sendEmail: sendEmailFunc });

  return true;
}