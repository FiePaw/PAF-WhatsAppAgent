// plugins/triggered/lms.js — Triggered plugin untuk intent natural LMS Telkom University.
import * as lms from '../../services/lmsClient.js';
import logger from '../../utils/logger.js';

function friendlyError(err) {
  if (err instanceof lms.LMSClientError) {
    if (err.status === 0) return '🔌 Server LMS API offline atau belum dijalankan (port 8000). Coba jalankan server LMS scraper terlebih dahulu.';
    if (err.status === 401) return '🔒 Autentikasi LMS API gagal (periksa LMS_API_KEY).';
    return `⚠️ ${err.message}`;
  }
  return `⚠️ Terjadi kesalahan: ${err?.message || err}`;
}

export default {
  intent: 'lms',
  name: 'LMS Telkom',
  description: 'Cek tugas, kuis, deadline, dan notifikasi LMS Telkom lewat bahasa natural',
  ownerOnly: true,

  intentDefinition:
    `"lms" - owner ingin mengecek atau mengelola data akademik LMS Telkom University: menanyakan tugas yang belum dikerjakan/dikumpul, kuis yang harus di-attempt, deadline tugas/kuis mendatang, notifikasi akademik LMS, atau meminta refresh/sinkronisasi LMS (contoh: "ada tugas apa aja di lms?", "cek kuis kalkulus", "deadline tugas minggu ini", "refresh data lms"). Pilih SATU action: pending_tasks (semua kuis & tugas pending), quiz_only (hanya kuis), assignment_only (hanya tugas), timeline (timeline deadline beberapa hari ke depan), notifications (notifikasi LMS), refresh_lms (sinkronisasi data).`,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['pending_tasks', 'quiz_only', 'assignment_only', 'timeline', 'notifications', 'refresh_lms'],
        description: 'Jenis aksi LMS yang diminta owner',
      },
      course: {
        type: 'string',
        description: 'Nama mata kuliah jika owner menyebutkan mata kuliah spesifik (misal: "kalkulus", "logika matematika")',
      },
      days: {
        type: 'integer',
        description: 'Rentang hari untuk timeline deadline (misal: 7, 14)',
      },
    },
    required: ['action'],
  },

  groupContextPrompt:
    'Kamu adalah asisten akademik LMS Telkom University. Kamu membantu menginformasikan tugas, kuis, deadline, dan aktivitas perkuliahan owner secara ringkas, jelas, dan santai.',

  handler: async ({ params, reply }) => {
    const action = params?.action || 'pending_tasks';
    const course = params?.course?.trim() || undefined;
    const days = params?.days ? Number(params.days) : 14;

    try {
      if (action === 'refresh_lms') {
        await reply('🔄 Memulai sinkronisasi LMS... Mohon tunggu beberapa detik.');
        const res = await lms.refresh({ full: true, deep_courses: true });
        const elapsed = res.elapsed_s ? ` dalam ${res.elapsed_s} detik` : '';
        await reply(`✅ Sinkronisasi LMS berhasil${elapsed}!\n• Timeline: ${res.timeline_count || 0} item\n• Notifikasi: ${res.notifications_cached || 0}\n• Course dipindai: ${res.deep_courses_scanned || 0}`);
        return;
      }

      if (action === 'notifications') {
        const notifData = await lms.getNotifications({ limit: 8 });
        await reply(lms.formatNotificationsView(notifData));
        return;
      }

      if (action === 'timeline') {
        const tlData = await lms.getTimeline({ days, status: 'all' });
        await reply(lms.formatTimelineView(tlData, days));
        return;
      }

      if (action === 'quiz_only') {
        const qData = await lms.getPendingTasks({ type: 'quiz', course, status: 'pending' });
        await reply(lms.formatPendingTasksView(qData, course ? `Mata Kuliah: ${course}` : 'Hanya Kuis'));
        return;
      }

      if (action === 'assignment_only') {
        const aData = await lms.getPendingTasks({ type: 'assign', course, status: 'pending' });
        await reply(lms.formatPendingTasksView(aData, course ? `Mata Kuliah: ${course}` : 'Hanya Tugas'));
        return;
      }

      // Default: pending_tasks (kuis + tugas)
      const data = await lms.getPendingTasks({ course, status: 'pending' });
      await reply(lms.formatPendingTasksView(data, course ? `Mata Kuliah: ${course}` : ''));
    } catch (err) {
      logger.error({ intent: 'lms', err: err.message }, 'Error di triggered plugin lms');
      await reply(friendlyError(err));
    }
  },
};
