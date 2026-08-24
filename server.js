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
        for (let i = 1; i <= 50; i++) {
          const status = row.get(`Audio ${i}`);
          const feedback = row.get(`Audio ${i} Feedback`);
          if (status !== undefined || i <= 24) {
             chunks.push({
               index: i,
               status: status || null,
               feedback: feedback || null
             });
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
      // New user
      const newRow = { 'Name': name, 'Email ID': email, 'Language': 'Not Assigned' };
      await sheet.addRow(newRow);
      
      const defaultChunks = Array.from({length: 24}, (_, i) => ({ index: i+1, status: null, feedback: null }));
      return res.json({
        success: true,
        user: { name, email },
        profiles: [{ language: 'Not Assigned', chunks: defaultChunks }]
      });
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

  ffmpeg(file.path)
    .toFormat('wav')
    .audioChannels(1)
    .audioFrequency(44100)
    .audioCodec('pcm_s16le')
    .audioFilters('afftdn')
    .on('end', async () => {
      console.log(`Successfully converted ${file.path} to ${outputPath}`);
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

      try {
        // Upload to Google Drive
        let driveFileId = null;
        if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
          const driveAuth = new google.auth.GoogleAuth({
            credentials: {
              client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
              private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            },
            scopes: ['https://www.googleapis.com/auth/drive.file'],
          });
          const drive = google.drive({ version: 'v3', auth: driveAuth });
          
          const driveRes = await drive.files.create({
            resource: { name: outputFilename, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
            media: { mimeType: 'audio/wav', body: fs.createReadStream(outputPath) },
            fields: 'id'
          });
          driveFileId = driveRes.data.id;
          console.log(`Uploaded to Drive: ${driveFileId}`);
          
          // Delete local converted file since it's on Drive now
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }

        const sheet = await getSheet();
        if (sheet) {
          const rows = await sheet.getRows();
          const userRow = rows.find(r => r.get('Email ID') === email && (r.get('Language') || 'Not Assigned') === language);
          if (userRow) {
            userRow.set(`Audio ${chunkIndex}`, 'Uploaded');
            await userRow.save();
          }
        }
        res.json({ success: true, message: 'Audio processed and saved to Drive', status: 'Uploaded' });
      } catch (error) {
        console.error('Error during Drive/Sheet update:', error);
        res.json({ success: true, message: 'Audio saved, but update failed', status: 'Uploaded' });
      }
    })
    .on('error', (err) => {
      console.error('FFmpeg error:', err);
      res.status(500).json({ error: 'Error processing audio file' });
    })
    .save(outputPath);
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`Uploads will be saved to ${UPLOADS_DIR}`);
});
