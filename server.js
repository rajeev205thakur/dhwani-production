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
        let i = 1;
        while (true) {
          const statusVal = row.get(`Audio ${i}`);
          if (statusVal !== undefined && statusVal !== null && statusVal !== '') {
             const clientStatus = row.get(`Audio ${i} Status`);
             const feedback = row.get(`Audio ${i} Feedback`);
             chunks.push({
               index: i,
               link: typeof statusVal === 'string' ? statusVal.replace('=HYPERLINK("', '').replace('", "Listen")', '') : statusVal,
               status: clientStatus || null,
               feedback: feedback || null
             });
             i++;
          } else {
             break;
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


// 2. Upload Audio Chunk
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
  const { email, chunkIndex, language } = req.body; 
  const file = req.file;

  if (!email || !chunkIndex || !language || !file) {
    return res.status(400).json({ error: 'Email, chunkIndex, language, and audio file are required' });
  }

  const outputFilename = `${Date.now()}-${email.replace(/[^a-zA-Z0-9]/g, '_')}-${language}-chunk${chunkIndex}.wav`;
  const outputPath = path.join(UPLOADS_DIR, outputFilename);

  // Removed afftdn (Noise Reduction) because it consumes too much RAM and crashes Render Free Tier
  ffmpeg(file.path)
    .toFormat('wav')
    .audioChannels(1)
    .audioFrequency(44100)
    .audioCodec('pcm_s16le')
    .on('end', async () => {
      console.log(`Successfully converted ${file.path} to ${outputPath}`);
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

      try {
        // Read the WAV file as Base64
        const fileBuffer = fs.readFileSync(outputPath);
        const base64Audio = fileBuffer.toString('base64');

        // Send to Google Apps Script
        const gasUrl = 'https://script.google.com/macros/s/AKfycbzh-jOOR4k3JJkVwYb0bgBH2wjCaTc3jCLRUgNSyLq7XxKvAd7CArYL8TUf8HaqNzDh/exec';
        
        console.log('Uploading to Google Drive via Apps Script...');
        const gasRes = await fetch(gasUrl, {
          method: 'POST',
          body: JSON.stringify({
            filename: outputFilename,
            base64Audio: base64Audio
          })
        });
        
        const gasData = await gasRes.json();
        if (!gasData.success) {
          throw new Error(gasData.error || 'Failed to upload to Drive via GAS');
        }

        const driveUrl = gasData.url;
        console.log(`Uploaded to Drive successfully: ${driveUrl}`);
        
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

        const sheet = await getSheet();
        if (sheet) {
          // Check and add missing headers
          await sheet.loadHeaderRow();
          const headerValues = sheet.headerValues;
          let headersChanged = false;
          const requiredHeaders = [`Audio ${chunkIndex}`, `Audio ${chunkIndex} Status`, `Audio ${chunkIndex} Feedback`];
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
          const userRow = rows.find(r => r.get('Email ID') === email && (r.get('Language') || 'Not Assigned') === language);
          if (userRow) {
            userRow.set(`Audio ${chunkIndex}`, driveUrl);
            userRow.set(`Audio ${chunkIndex} Status`, 'In Review');
            userRow.set(`Audio ${chunkIndex} Feedback`, '');
            await userRow.save();
          }
        }
        res.json({ success: true, message: 'Audio processed and saved to Google Drive', status: 'In Review' });
      } catch (error) {
        console.error('Error during upload/sheet update:', error);
        res.json({ success: true, message: 'Audio saved, but update failed', status: 'In Review' });
      }
    })
    .on('error', (err) => {
      console.error('FFmpeg error:', err);
      res.status(500).json({ error: 'Error processing audio file' });
    })
    .save(outputPath);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`Uploads will be saved to ${UPLOADS_DIR}`);
});
