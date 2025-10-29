import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { joinVoiceChannel, VoiceConnectionStatus, createAudioPlayer, createAudioResource, StreamType } from "@discordjs/voice";
import { handleMessage } from "./message.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

console.log('🔑 OpenAI Key loaded:', !!process.env.OPENAI_API_KEY);

const voiceConnections = new Map();
const audioReceivers = new Map();

export async function handleVoice(message, db, model, transporter, pendingConfirmations, join = true) {
  if (!message.member?.voice.channel) {
    await message.reply("⚠️ You need to be in a voice channel!");
    return;
  }

  const guildId = message.guild.id;

  if (join) {
    try {
      const connection = joinVoiceChannel({
        channelId: message.member.voice.channel.id,
        guildId: guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      voiceConnections.set(guildId, connection);

      connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`🔊 Ready to receive audio in guild ${guildId}`);
        
        const receiver = connection.receiver;
        audioReceivers.set(guildId, receiver);
        console.log(`🎤 Receiver initialized for guild ${guildId}, user ID: ${message.author.id}`);

        // Play short silence to trigger packet flow
        const silence = Buffer.alloc(3840); // 20ms silence
        const silenceStream = new Readable({
          read() { this.push(silence); }
        });
        const resource = createAudioResource(silenceStream, { inputType: StreamType.Raw });
        const player = createAudioPlayer();
        player.play(resource);
        connection.subscribe(player);
        setTimeout(() => player.stop(), 500); // Play for 500ms to ensure packet flow

        receiver.speaking.on('start', (userId) => {
          console.log(`👤 Speaking detected: user ${userId} in guild ${guildId}`);
          if (userId === message.author.id) {
            console.log(`🎙️ Capturing audio from ${userId}`);
            
            const audioStream = receiver.subscribe(userId, {
              end: { behavior: 'afterSilence', duration: 5000 } // Increased to 5 seconds
            });

            const chunks = [];
            audioStream.on('data', (chunk) => {
              chunks.push(chunk);
              console.log(`📦 Audio chunk received, size: ${chunk.length} bytes`);
            });
            
            audioStream.on('end', async () => {
              console.log(`🎵 Audio stream ended, total chunks: ${chunks.length}`);
              if (chunks.length === 0) {
                console.log('⚠️ No audio chunks captured!');
                message.channel.send('⚠️ No audio detected. Check microphone or speak louder.').catch(console.error);
                return;
              }

              try {
                const audioBuffer = Buffer.concat(chunks);
                console.log(`🎵 Audio captured: ${audioBuffer.length} bytes`);

                const tempFile = path.join(__dirname, `temp_audio_${Date.now()}.wav`);
                fs.writeFileSync(tempFile, audioBuffer);

                console.log(`📝 Transcribing file: ${tempFile}`);
                const transcription = await openai.audio.transcriptions.create({
                  file: fs.createReadStream(tempFile),
                  model: 'whisper-1',
                  language: 'en',
                });

                fs.unlinkSync(tempFile);

                console.log(`🎙️ Transcribed: "${transcription.text}"`);
                
                const fakeMessage = {
                  content: transcription.text,
                  author: message.author,
                  guild: message.guild,
                  channel: message.channel,
                  reply: async (content) => await message.channel.send(content),
                };

                await handleMessage(fakeMessage, db, model, transporter, pendingConfirmations);
              } catch (err) {
                console.error('❌ Transcription error:', err);
                message.channel.send('⚠️ Failed to transcribe voice.').catch(console.error);
              }
            });

            audioStream.on('error', (err) => {
              console.error('❌ Audio stream error:', err);
            });
          } else {
            console.log(`⏭️ Ignoring speech from ${userId} (not command issuer)`);
          }
        });

        receiver.speaking.on('end', (userId) => {
          console.log(`👤 Speaking ended: user ${userId}`);
        });

        message.channel.send("✅ Listening for voice commands! Say 'hello' or email commands.").catch(console.error);
      });

      connection.on('error', (err) => {
        console.error(`❌ Voice connection error in guild ${guildId}:`, err);
      });

    } catch (err) {
      console.error('❌ Voice join error:', err);
      message.channel.send('⚠️ Failed to join voice.').catch(console.error);
    }
  } else {
    const connection = voiceConnections.get(guildId);
    if (connection) {
      connection.destroy();
      voiceConnections.delete(guildId);
      audioReceivers.delete(guildId);
      await message.reply("✅ Left voice channel.");
    }
  }
}