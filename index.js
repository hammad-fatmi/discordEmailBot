import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import nodemailer from "nodemailer";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { handleMessage } from "./message.js";
import { handleVoice } from "./voice.js"; // Note: This is likely broken since voice.js is deleted

// Load .env
dotenv.config();

// Verify environment variables
console.log("🔑 Google Key Loaded:", !!process.env.GOOGLE_API_KEY);
console.log("🔑 Discord Token Loaded:", !!process.env.DISCORD_BOT_TOKEN);
console.log("🔑 Gmail Address Loaded:", !!process.env.GMAIL_ADDRESS);
console.log("🔑 Gmail App Password Loaded:", !!process.env.GMAIL_APP_PASSWORD);

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Initialize Discord client with voice intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Initialize nodemailer transporter
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_ADDRESS,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

// Initialize SQLite database
const dbPath = "./emails.db";
let db;

// Store pending confirmations
const pendingConfirmations = new Map();

(async () => {
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      alias TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      UNIQUE(email)
    )
  `);

  // Discord event handlers
  client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // Handle confirmation (yes/no) replies
    if (pendingConfirmations.has(message.author.id)) {
      const { data, timer, sendEmail } = pendingConfirmations.get(message.author.id);
      clearTimeout(timer);

      const reply = message.content.toLowerCase().trim();

      if (reply === "yes") {
        try {
          await sendEmail(data);
          await message.reply(
            `✅ Email sent successfully to ${data.toEmails.length} To, ${data.ccEmails.length} CC, ${data.bccEmails.length} BCC.`
          );
        } catch (err) {
          console.error("❌ Error sending email:", err);
          await message.reply("⚠️ Failed to send email. Please try again.");
        }
      } else {
        await message.reply("❌ Email cancelled. You can write a new one anytime.");
      }

      pendingConfirmations.delete(message.author.id);
      return;
    }

    // Handle voice commands explicitly (case-insensitive with spaces)
    const cleanPrompt = message.content.trim().toLowerCase();
    if (cleanPrompt === "!join" || cleanPrompt === "join voice" || cleanPrompt.match(/^!join\s*$/i)) {
      try {
        await handleVoice(message, db, model, transporter, pendingConfirmations, true);
        return;
      } catch (err) {
        console.error("❌ Error handling join voice:", err);
        await message.reply("⚠️ Failed to join voice channel. Check permissions!");
        return;
      }
    }
    if (cleanPrompt === "!leave" || cleanPrompt === "leave voice" || cleanPrompt.match(/^!leave\s*$/i)) {
      try {
        await handleVoice(message, db, model, transporter, pendingConfirmations, false);
        return;
      } catch (err) {
        console.error("❌ Error handling leave voice:", err);
        await message.reply("⚠️ Failed to leave voice channel.");
        return;
      }
    }

    // Process regular text messages
    try {
      await handleMessage(message, db, model, transporter, pendingConfirmations);
    } catch (err) {
      console.error("❌ Unhandled error in handleMessage:", err);
      await message.reply("⚠️ Something went wrong. Please try again.");
    }
  });

  // Login to Discord
  client.login(process.env.DISCORD_BOT_TOKEN);
})();