// plugins/lms.js — Command plugin MyLMS: !lms, !tugas, !kuis
import * as lms from '../services/lmsClient.js';
import logger from '../utils/logger.js';

function friendlyError(err) {
  if (err instanceof lms.LMSClientError) {
    if (err.status === 0) return '🔌 Server LMS API offline atau belum dijalankan (port 8000).';
    if (err.status === 401) return '🔒 Autentikasi LMS API gagal (periksa LMS_API_KEY).';
    return `⚠️ ${err.message}`;
  }
  return `⚠️ Terjadi kesalahan: ${err?.message || err}`;
}

async function handleLmsCommand({ args, fullArgs, reply }) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'refresh') {
    await reply('🔄 Memulai sinkronisasi LMS menyeluruh (deep scan & notifikasi)... Mohon tunggu.');
    try {
      const res = await lms.refresh({ full: true, deep_courses: true });
      const elapsed = res.elapsed_s ? ` dalam ${res.elapsed_s}s` : '';
      await reply(`✅ Sinkronisasi LMS selesai${elapsed}!\n• Timeline: ${res.timeline_count || 0} item\n• Notifikasi: ${res.notifications_cached || 0}\n• Course dipindai: ${res.deep_courses_scanned || 0}`);
    } catch (err) {
      await reply(friendlyError(err));
    }
    return;
  }

  if (sub === 'notif' || sub === 'notifications') {
    try {
      const data = await lms.getNotifications({ limit: 10 });
      await reply(lms.formatNotificationsView(data));
    } catch (err) {
      await reply(friendlyError(err));
    }
    return;
  }

  if (sub === 'timeline') {
    const days = parseInt(args[1]) || 14;
    try {
      const data = await lms.getTimeline({ days, status: 'all' });
      await reply(lms.formatTimelineView(data, days));
    } catch (err) {
      await reply(friendlyError(err));
    }
    return;
  }

  // Default !lms: Tampilkan ringkasan status & pending tasks
  try {
    const [health, pending] = await Promise.all([
      lms.getHealth().catch(() => null),
      lms.getPendingTasks({ status: 'pending' }),
    ]);

    let text = '';
    if (health) {
      const stateIcon = health.state === 'ready' ? '🟢' : health.state === 'auth_required' ? '🟡 (Butuh Login SSO)' : '🔴';
      text += `🏛️ *Status LMS Telkom University*\n`;
      text += `• Status Sesi: ${stateIcon} ${health.state}\n`;
      text += `• Enrolled Courses: *${health.courses_count || 0}*\n`;
      text += `• Notifikasi Unread: *${health.unread_count ?? '-'}*\n\n`;
    }

    text += lms.formatPendingTasksView(pending);
    text += `\n\n_Ketik *!tugas* untuk khusus tugas, *!kuis* untuk kuis, atau *!lms refresh* untuk sinkronisasi._`;
    await reply(text);
  } catch (err) {
    await reply(friendlyError(err));
  }
}

async function handleTugasCommand({ fullArgs, reply }) {
  const courseFilter = fullArgs?.trim() || undefined;
  try {
    const data = await lms.getPendingTasks({ type: 'assign', course: courseFilter, status: 'pending' });
    await reply(lms.formatPendingTasksView(data, courseFilter ? `Mata Kuliah: ${courseFilter}` : 'Hanya Tugas'));
  } catch (err) {
    await reply(friendlyError(err));
  }
}

async function handleKuisCommand({ fullArgs, reply }) {
  const courseFilter = fullArgs?.trim() || undefined;
  try {
    const data = await lms.getPendingTasks({ type: 'quiz', course: courseFilter, status: 'pending' });
    await reply(lms.formatPendingTasksView(data, courseFilter ? `Mata Kuliah: ${courseFilter}` : 'Hanya Kuis'));
  } catch (err) {
    await reply(friendlyError(err));
  }
}

export default {
  name: 'lms',
  description: 'LMS Telkom University: pantau tugas, kuis, deadline, notifikasi, dan refresh data',
  commands: ['lms', 'tugas', 'kuis'],
  ownerOnly: true,

  handler: async ({ command, args, fullArgs, reply }) => {
    try {
      switch (command) {
        case 'lms':
          await handleLmsCommand({ args, fullArgs, reply });
          break;
        case 'tugas':
          await handleTugasCommand({ fullArgs, reply });
          break;
        case 'kuis':
          await handleKuisCommand({ fullArgs, reply });
          break;
        default:
          break;
      }
    } catch (err) {
      logger.error({ command, err: err.message }, 'Error di plugin lms');
      await reply(friendlyError(err));
    }
  },
};
