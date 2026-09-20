// services/socialMediaService.js
// [Fitur 3 · Konteks dari URL Instagram/TikTok]
//
// Download video dari URL Instagram/TikTok via binary eksternal `yt-dlp`,
// lalu konversi ke attachment base64 siap dikirim ke Qwen — Opsi B (lihat
// rencana-fitur-baru-PAF-WhatsAppAgent.md): video dikirim MENTAH sebagai
// attachment, TIDAK ADA transcribe lokal (Whisper) atau extract-frame lokal
// (ffmpeg + describeImage manual). Mekanisme attachment yang dipakai persis
// sama dengan gambar/dokumen (services/aiService.js sudah generik: routing
// model ke Qwen berdasar attachments.length, bukan cek tipe spesifik).
//
// ⚠️ Kebutuhan operasional (WAJIB dibaca sebelum deploy):
//   - Binary `yt-dlp` (Python) harus terinstall terpisah di server (pip/apt/
//     binary release) dan di-update berkala — Instagram/TikTok sering ubah
//     struktur, yt-dlp yang usang akan gagal diam-diam.
//   - Cookies akun IG/TikTok milik OWNER SENDIRI diperlukan untuk akses
//     konten privat (config.socialMedia.instagramCookiesPath /
//     tiktokCookiesPath, dari .env). Tanpa cookies, hanya konten publik yang
//     bisa diakses.
//   - Ini melanggar ToS kedua platform → risiko akun owner kena flag/
//     suspend/banned (sudah disetujui sadar oleh owner, lihat dokumen
//     rencana). Cookies WAJIB disimpan aman (di luar repo git, permission
//     file dibatasi) — bocor cookies = orang lain bisa login sebagai owner.

import { spawn } from 'child_process';
import { readFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import config from '../config/config.js';
import logger from '../utils/logger.js';

// Deteksi URL instagram.com / tiktok.com / vt.tiktok.com / vm.tiktok.com
const URL_REGEX = /(https?:\/\/(?:www\.|vt\.|vm\.)?(?:instagram\.com|tiktok\.com)\/[^\s]+)/i;

// Batas ukuran file download — jaga-jaga video sangat panjang tidak
// menyebabkan base64 raksasa yang bikin request ke gateway timeout/gagal.
const MAX_FILESIZE = '100M';
const YT_DLP_TIMEOUT_MS = 5 * 60 * 1000; // 5 menit

/**
 * Deteksi URL Instagram/TikTok pertama dalam teks.
 * @param {string} text
 * @returns {string|null}
 */
export function extractSocialMediaUrl(text) {
  if (!text) return null;
  const match = text.match(URL_REGEX);
  return match ? match[1] : null;
}

/**
 * Pilih path cookies sesuai platform dari URL.
 * @param {string} url
 * @returns {string|null}
 */
function cookiesPathFor(url) {
  if (/instagram\.com/i.test(url)) return config.socialMedia?.instagramCookiesPath || null;
  if (/tiktok\.com/i.test(url)) return config.socialMedia?.tiktokCookiesPath || null;
  return null;
}

/**
 * Jalankan binary `yt-dlp` sebagai child process, kumpulkan stdout/stderr.
 * Reject jika binary tidak ditemukan, exit code != 0, atau timeout.
 *
 * @param {string[]} args
 * @returns {Promise<string>} stdout
 */
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`yt-dlp timeout setelah ${YT_DLP_TIMEOUT_MS / 1000}s`));
    }, YT_DLP_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Biasanya berarti binary yt-dlp tidak terinstall di server
      reject(new Error(`Gagal menjalankan yt-dlp (mungkin belum terinstall di server): ${err.message}`));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `yt-dlp exit code ${code}`));
      resolve(stdout);
    });
  });
}

/**
 * Download media dari URL Instagram/TikTok via yt-dlp, kembalikan sebagai
 * attachment base64 siap kirim ke Qwen (mekanisme sama dengan gambar/dokumen)
 * plus metadata teks (judul/deskripsi) sebagai fallback konteks.
 *
 * @param {string} url
 * @returns {Promise<{ attachment: { filename: string, data: string, mime_type: string }, metadata: { title: string, description: string, uploader: string } } | null>}
 */
export async function downloadSocialMedia(url) {
  const cookiesPath = cookiesPathFor(url);
  let tmpDir;

  try {
    tmpDir = await mkdtemp(join(tmpdir(), 'paf-social-'));
  } catch (err) {
    logger.error({ url, err: err.message }, '❌ socialMediaService: gagal buat temp dir');
    return null;
  }

  const outputTemplate = join(tmpDir, 'media.%(ext)s');

  try {
    const args = [
      url,
      '-o', outputTemplate,
      '--no-playlist',
      '--max-filesize', MAX_FILESIZE,
      '--print-json',
      '--no-simulate',
    ];

    if (cookiesPath) {
      args.push('--cookies', cookiesPath);
    } else {
      logger.warn({ url }, '⚠️ socialMediaService: tidak ada cookies untuk platform ini, hanya konten publik yang bisa diakses');
    }

    const stdout = await runYtDlp(args);

    // yt-dlp --print-json mencetak satu baris JSON per item — ambil baris terakhir yang valid
    const lines = stdout.trim().split('\n').filter(Boolean);
    const infoLine = lines[lines.length - 1];
    const info = JSON.parse(infoLine);

    const downloadedPath = info?.requested_downloads?.[0]?.filepath || info?._filename;
    if (!downloadedPath) throw new Error('yt-dlp tidak mengembalikan path file hasil download');

    const buffer = await readFile(downloadedPath);
    const ext = downloadedPath.split('.').pop() || 'mp4';
    const mimeType = ext === 'mp3' || ext === 'm4a' ? `audio/${ext}` : `video/${ext}`;

    const attachment = {
      filename: `social_${Date.now()}.${ext}`,
      data: buffer.toString('base64'),
      mime_type: mimeType,
    };

    const metadata = {
      title: info?.title || '',
      description: info?.description || '',
      uploader: info?.uploader || '',
    };

    logger.info({ url, sizeKb: Math.round(buffer.length / 1024) }, '✅ socialMediaService: media berhasil di-download');
    return { attachment, metadata };
  } catch (err) {
    logger.error({ url, err: err.message }, '❌ socialMediaService: gagal download media');
    return null;
  } finally {
    // Bersihkan temp dir — di-await agar dijamin selesai sebelum function
    // return, tidak boleh menumpuk file video di disk (fire-and-forget
    // berisiko tidak sempat jalan jika proses berhenti tepat setelahnya).
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      logger.warn({ tmpDir, err: cleanupErr.message }, '⚠️ socialMediaService: gagal bersihkan temp dir');
    }
  }
}
