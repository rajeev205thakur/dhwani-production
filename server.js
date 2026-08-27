import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

// Setup multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Helper to authenticate Google Sheets
const getSheet = async () => {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_SHEET_ID) {
    console.warn("Google Sheets credentials not fully provided in .env. Mocking response.");
    return null;
  }
  
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  return doc.sheetsByIndex[0]; // Assuming data is in the first tab
};

// --- API Endpoints ---

// 1. Login Endpoint
app.post('/api/login', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

  try {
    const sheet = await getSheet();
    if (!sheet) {
      return res.json({ 
        success: true, 
        user: { name, email },
        profiles: [{
          language: 'Hindi (Mock)',
          chunks: Array.from({length: 24}, (_, i) => ({ index: i+1, status: null, feedback: null }))
        }]
      });
    }

    const rows = await sheet.getRows();
    const userRows = rows.filter(r => r.get('Email ID') === email);

    if (userRows.length > 0) {
      const profiles = userRows.map(row => {
        const chunks = [];
        // Find max chunk index by inspecting headers
        let maxChunk = 0;
        sheet.headerValues.forEach(h => {
          const match = h.match(/^Audio (\d+)$/);
          if (match) {
            maxChunk = Math.max(maxChunk, parseInt(match[1]));
          }
        });

        for (let i = 1; i <= maxChunk; i++) {
          const statusVal = row.get(`Audio ${i}`);
          const clientStatus = row.get(`Audio ${i} Status`);
          const feedback = row.get(`Audio ${i} Feedback`);
          
          if (statusVal || clientStatus) {
            chunks.push({
               index: i,
               link: typeof statusVal === 'string' ? statusVal.replace('=HYPERLINK("', '').replace('", "Listen")', '') : statusVal,
               status: clientStatus || null,
               feedback: feedback || null
            });
          }
        }

        return {
          language: row.get('Language') || 'Not Assigned',
          chunks
        };
      });

      return res.json({
        success: true,
        user: {
          name: userRows[0].get('Name') || name,
          email
        },
        profiles
      });
    } else {
      // Reject new users
      return res.status(401).json({ error: 'Your email is not in the approved list. Please contact the administrator.' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});


// Basic queue to prevent Out-Of-Memory crashes from concurrent ffmpeg/base64 conversions
const uploadQueue = [];
let isProcessingQueue = false;

const processUploadQueue = async () => {
  if (isProcessingQueue || uploadQueue.length === 0) return;
  isProcessingQueue = true;

  const task = uploadQueue.shift();
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(task.filePath)
        .toFormat('wav')
        .audioChannels(1)
        .audioFrequency(44100)
        .audioCodec('pcm_s16le')
        .on('end', async () => {
          console.log(`Successfully converted ${task.filePath} to ${task.outputPath}`);
          if (fs.existsSync(task.filePath)) fs.unlinkSync(task.filePath);

          try {
            const fileBuffer = fs.readFileSync(task.outputPath);
            const base64Audio = fileBuffer.toString('base64');
            
            console.log('Uploading to Google Drive via Apps Script...');
            const gasUrl = 'https://script.google.com/macros/s/AKfycbzh-jOOR4k3JJkVwYb0bgBH2wjCaTc3jCLRUgNSyLq7XxKvAd7CArYL8TUf8HaqNzDh/exec';
            
            const gasResponse = await fetch(gasUrl, {
              method: 'POST',
              body: JSON.stringify({
                filename: path.basename(task.outputPath),
                base64Audio: base64Audio
              })
            });

            const gasData = await gasResponse.json();
            
            if (!gasData.success) {
              throw new Error(gasData.error || 'Failed to upload to Drive via GAS');
            }

            const driveUrl = gasData.url || 'URL_NOT_RETURNED';
            
            if (fs.existsSync(task.outputPath)) fs.unlinkSync(task.outputPath);

            let retries = 3;
            while (retries > 0) {
              try {
                const sheet = await getSheet();
                if (sheet) {
                  await sheet.loadHeaderRow();
                  const headerValues = sheet.headerValues;
                  let headersChanged = false;
                  const requiredHeaders = [`Audio ${task.chunkIndex}`, `Audio ${task.chunkIndex} Status`, `Audio ${task.chunkIndex} Feedback`];
                  for (const header of requiredHeaders) {
                    if (!headerValues.includes(header)) {
                      headerValues.push(header);
                      headersChanged = true;
                    }
                  }
                  if (headersChanged) {
                    await sheet.setHeaderRow(headerValues);
                  }

                  const rows = await sheet.getRows();
                  // Match robustly by Email ID (ignore case and spacing), skip language matching just to be safe
                  const userRows = rows.filter(r => {
                    const rEmail = r.get('Email ID') || '';
                    return rEmail.trim().toLowerCase() === task.email.trim().toLowerCase();
                  });
                  
                  if (userRows.length > 0) {
                    for (const userRow of userRows) {
                      userRow.set(`Audio ${task.chunkIndex}`, driveUrl);
                      userRow.set(`Audio ${task.chunkIndex} Status`, 'In Review');
                      userRow.set(`Audio ${task.chunkIndex} Feedback`, '');
                      await userRow.save();
                    }
                    console.log(`Background task finished successfully and saved to sheet for ${task.email}.`);
                    break; // Break retry loop on success
                  } else {
                    console.error(`User row not found in sheet for email: ${task.email}`);
                    break; // No point retrying if row doesn't exist
                  }
                }
              } catch (sheetErr) {
                console.error(`Sheet update failed. Retries left: ${retries - 1}`, sheetErr);
                retries--;
                if (retries === 0) throw sheetErr;
                await new Promise(r => setTimeout(r, 3000)); // wait 3s before retry
              }
            }
            resolve();
          } catch (error) {
            console.error('Error during background processing:', error);
            resolve(); // Resolve anyway to unblock queue
          }
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          if (fs.existsSync(task.filePath)) fs.unlinkSync(task.filePath);
          resolve(); // Unblock queue
        })
        .save(task.outputPath);
    });
  } catch (err) {
    console.error("Queue task error:", err);
  }

  isProcessingQueue = false;
  // Process next item if any
  processUploadQueue();
};

// 2. Upload Audio Chunk
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
  const { email, chunkIndex, language } = req.body; 
  const file = req.file;

  if (!email || !chunkIndex || !language || !file) {
    return res.status(400).json({ error: 'Email, chunkIndex, language, and audio file are required' });
  }

  const outputFilename = `${Date.now()}-${email.replace(/[^a-zA-Z0-9]/g, '_')}-${language}-chunk${chunkIndex}.wav`;
  const outputPath = path.join(UPLOADS_DIR, outputFilename);

  // Send success response immediately to prevent Render timeout
  res.json({ success: true, message: 'Audio uploaded successfully. Processing in background...', status: 'Processing' });

  // Add to queue and trigger processing
  uploadQueue.push({
    email,
    chunkIndex,
    language,
    filePath: file.path,
    outputPath
  });
  
  processUploadQueue();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`Uploads will be saved to ${UPLOADS_DIR}`);
});
