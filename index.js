const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

/**
 * CONFIGURAÇÕES E CONSTANTES
 */
const SPECIALTIES = [
  'Clínico Geral', 'Médico da Família', 'Medicina do Trabalho',
  'Angiologia', 'Alergologia', 'Cardiologia', 'Dermatologia',
  'Endocrinologia', 'Geriatria', 'Ginecologia', 'Hematologia',
  'Infectologia', 'Nefrologia', 'Neurologia', 'Nutricionista',
  'Ortopedia', 'Psicologia', 'Psiquiatria', 'Reumatologia',
  'Gastroenterologia', 'Urologia', 'Fisiatria', 'Pneumologia',
  'Alergologia Infantil', 'Endocrinologia Infantil', 'Neurologia Infantil',
  'Ortopedia Infantil', 'Psicologia Infantil', 'Psiquiatria Infantil',
  'Reumatologia Infantil', 'Gastroenterologia Infantil', 'Pneumologia Infantil',
  'Pediatria'
];

const ADMIN_NUMBERS = [
  '554288659855',
  '5542999262497',
  '5542000000000'
];

const DB_FILE = './db.json';
const userSessions = new Map();
const REMINDER_CHECK_INTERVAL_MS = 60 * 1000;

// Configuração do Banco de Dados
const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter, { appointments: [] });

/**
 * FUNÇÕES AUXILIARES
 */
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function isValidDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return false;
  const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isValidTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function parseDateTime(date, time) {
  const [day, month, year] = date.split('/').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function formatSpecialties() {
  const lines = SPECIALTIES.map((specialty, index) => `${index + 1}. ${specialty}`);
  return `📅 *Especialidades disponíveis:*\n\n${lines.join('\n')}\n\nResponda com o número da especialidade desejada.`;
}

function formatAppointment(appointment) {
  const lines = [
    `📅 ${appointment.date}`,
    `⏰ ${appointment.time}`,
    `👤 ${appointment.name}`,
    `Especialidade: ${appointment.specialty}`
  ];
  if (appointment.consultationType) lines.push(`Modalidade: ${appointment.consultationType}`);
  if (appointment.status) lines.push(`Status: ${appointment.status}`);
  return lines.join('\n');
}

/**
 * PERSISTÊNCIA
 */
async function initDatabase() {
  await db.read();
  db.data ||= { appointments: [] };
  await db.write();
}

async function saveAppointment(appointment) {
  db.data.appointments.push(appointment);
  await db.write();
}

async function updateAppointmentById(appointmentId, updates) {
  await db.read();
  const appointment = db.data.appointments.find((item) => item.id === appointmentId);
  if (!appointment) return null;
  Object.assign(appointment, updates);
  await db.write();
  return appointment;
}

async function getAppointmentsByPhone(phone) {
  await db.read();
  return db.data.appointments
    .filter((appointment) => appointment.phone === phone)
    .sort((a, b) => parseDateTime(a.date, a.time) - parseDateTime(b.date, b.time));
}

async function getTodayAppointments() {
  await db.read();
  const now = new Date();
  const today = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  return db.data.appointments
    .filter((appointment) => appointment.date === today && appointment.status !== 'Cancelada')
    .sort((a, b) => a.time.localeCompare(b.time));
}

async function hasScheduleConflict(date, time) {
  await db.read();
  return db.data.appointments.some(
    (appointment) => appointment.date === date && appointment.time === time && appointment.status !== 'Cancelada'
  );
}

/**
 * FLUXOS DE CONVERSA
 */
function resetSession(phone) {
  userSessions.delete(phone);
}

async function handleSchedulingFlow(message, phone, text) {
  const session = userSessions.get(phone);
  if (!session || session.type !== 'scheduling') return false;

  if (text.toLowerCase() === 'cancelar') {
    resetSession(phone);
    await message.reply('Atendimento cancelado.');
    return true;
  }

  switch (session.step) {
    case 'specialty':
      const option = Number(text);
      if (!Number.isInteger(option) || option < 1 || option > SPECIALTIES.length) {
        await message.reply('Número inválido. Escolha uma opção da lista.');
        return true;
      }
      session.specialty = SPECIALTIES[option - 1];
      session.step = 'name';
      await message.reply(`Especialidade: *${session.specialty}*.\n\n👤 Informe o nome completo do paciente.`);
      break;

    case 'name':
      if (text.length < 3) {
        await message.reply('Informe um nome válido.');
        return true;
      }
      session.name = text;
      session.step = 'date';
      await message.reply('📅 Informe a data no formato *DD/MM/YYYY*.');
      break;

    case 'date':
      if (!isValidDate(text)) {
        await message.reply('Data inválida. Use *DD/MM/YYYY*.');
        return true;
      }
      session.date = text;
      session.step = 'time';
      await message.reply('⏰ Informe o horário no formato *HH:mm*.');
      break;

    case 'time':
      if (!isValidTime(text)) {
        await message.reply('Horário inválido.');
        return true;
      }
      if (await hasScheduleConflict(session.date, text)) {
        await message.reply('Horário ocupado. Escolha outro.');
        return true;
      }
      const appointment = {
        id: `${Date.now()}-${phone}`,
        phone,
        name: session.name,
        specialty: session.specialty,
        date: session.date,
        time: text,
        createdAt: new Date().toISOString()
      };
      await saveAppointment(appointment);
      resetSession(phone);
      await message.reply(`Agendado!\n\n${formatAppointment(appointment)}`);
      break;
  }
  return true;
}

async function handleConsultationTypeFlow(message, phone, text) {
  const session = userSessions.get(phone);
  if (!session || session.type !== 'consultation_type') return false;

  const norm = text.trim().toLowerCase();
  if (norm === 'cancelar') {
    await updateAppointmentById(session.appointmentId, { status: 'Cancelada' });
    resetSession(phone);
    await message.reply('Consulta cancelada.');
    return true;
  }

  let type = null;
  if (['1', 'presencial'].includes(norm)) type = 'Presencial';
  if (['2', 'teleconsulta', 'online'].includes(norm)) type = 'Teleconsulta';

  if (!type) {
    await message.reply('Responda *1* para presencial ou *2* para teleconsulta.');
    return true;
  }

  const updated = await updateAppointmentById(session.appointmentId, {
    consultationType: type,
    consultationTypeStatus: 'Confirmada'
  });
  resetSession(phone);
  await message.reply(`Confirmado como *${type}*!\n\n${formatAppointment(updated)}`);
  return true;
}

/**
 * LEMBRETES
 */
async function sendConsultationTypeReminder(client, appointment) {
  const phone = normalizePhone(appointment.phone);
  const chatId = `${phone}@c.us`;

  try {
    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) return;

    userSessions.set(phone, { type: 'consultation_type', appointmentId: appointment.id });
    await client.sendMessage(chatId, `Olá, ${appointment.name}! Sua consulta é hoje às *${appointment.time}*.\n\nSerá 1. Presencial ou 2. Teleconsulta?`);
    
    await updateAppointmentById(appointment.id, { reminderSentAt: new Date().toISOString() });
  } catch (e) { console.error(e); }
}

async function processAppointmentReminders(client) {
  await db.read();
  const now = new Date();
  for (const app of (db.data.appointments || [])) {
    if (app.reminderSentAt || app.consultationType || app.status === 'Cancelada') continue;
    const appDT = parseDateTime(app.date, app.time);
    if (now >= new Date(appDT.getTime() - 2 * 60 * 60 * 1000) && now < appDT) {
      await sendConsultationTypeReminder(client, app);
    }
  }
}

/**
 * MAIN
 */
async function main() {
  await initDatabase();
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox'] }
  });

  client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
  client.on('ready', () => {
    console.log('Bot conectado.');
    setInterval(() => processAppointmentReminders(client), REMINDER_CHECK_INTERVAL_MS);
  });

  client.on('message', async (msg) => {
    if (msg.from.includes('@g.us')) return;

    // CAPTURA DO NÚMERO REAL (RESOLVE O PROBLEMA DO LID)
    const contact = await msg.getContact();
    const phone = contact.number; 
    const text = (msg.body || '').trim();

    if (await handleConsultationTypeFlow(msg, phone, text)) return;
    if (await handleSchedulingFlow(msg, phone, text)) return;

    const normText = text.toLowerCase();
    if (normText === 'agendar') {
      userSessions.set(phone, { type: 'scheduling', step: 'specialty' });
      await msg.reply(formatSpecialties());
    } else if (normText === 'consultas') {
      const apps = await getAppointmentsByPhone(phone);
      await msg.reply(apps.length ? apps.map(a => formatAppointment(a)).join('\n\n') : 'Sem consultas.');
    } else if (normText === '/agenda' && ADMIN_NUMBERS.includes(phone)) {
      const today = await getTodayAppointments();
      await msg.reply(today.length ? today.map(a => `${a.time} - ${a.name}`).join('\n') : 'Agenda vazia.');
    } else {
      userSessions.set(phone, { type: 'scheduling', step: 'specialty' });
      await msg.reply(`Olá! Vamos agendar?\n\n${formatSpecialties()}`);
    }
  });

  await client.initialize();
}

main().catch(console.error);