const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

/**
 * ═══════════════════════════════════════════════════════
 * CONFIGURAÇÕES
 * ═══════════════════════════════════════════════════════
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

const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter, { appointments: [] });

// ─── MENUS ───────────────────────────────────────────────────────────────────

const MAIN_MENU = `👋 Olá! Sou o assistente de agendamentos.

1️⃣  Agendar consulta
2️⃣  Minhas consultas
3️⃣  Cancelar consulta
4️⃣  Reagendar consulta

Digite o número da opção desejada.`;

const ADMIN_HELP = `⚙️ *Comandos administrativos:*

/agenda — agenda de hoje
/agenda DD/MM/AAAA — agenda de uma data
/buscar [nome ou CPF] — buscar paciente
/cancelar [id] — apagar consulta do sistema
/relatorio — resumo geral`;

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function isValidCPF(cpf) {
  cpf = cpf.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i);
  let rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  if (rem !== parseInt(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i);
  rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  return rem === parseInt(cpf[10]);
}

function formatCPF(cpf) {
  cpf = String(cpf || '').replace(/\D/g, '');
  return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

function isValidDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return false;
  const [, d, m, y] = match.map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function isDateInPast(value) {
  const [d, m, y] = value.split('/').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function isValidTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, h, min] = match.map(Number);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function parseDateTime(date, time) {
  const [d, m, y] = date.split('/').map(Number);
  const [h, min] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0);
}

function formatSpecialties() {
  return `📋 *Especialidades disponíveis:*\n\n${SPECIALTIES.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nDigite o número ou *cancelar* para voltar.`;
}

function formatAppointment(a, index) {
  const prefix = index != null ? `*[${index}]* ` : '';
  const lines = [
    `${prefix}📅 ${a.date} às ⏰ ${a.time}`,
    `👤 Paciente: ${a.name}`,
    `🪪 CPF: ${formatCPF(a.cpf)}`,
    `📍 Tipo: *${a.consultationType}*`,
    `🏠 Endereço: ${a.address || 'Não exigido'}`,
    `🩺 Especialidade: ${a.specialty}`,
  ];
  if (a.confirmationStatus) lines.push(`✅ Presença: ${a.confirmationStatus}`);
  lines.push(`🔖 Status: ${a.status || 'Agendada'}`);
  return lines.join('\n');
}

function generateId(phone) {
  return `${Date.now()}-${phone}`;
}

// ═══════════════════════════════════════════════════════
//  BANCO DE DADOS
// ═══════════════════════════════════════════════════════

async function initDatabase() {
  await db.read();
  db.data ||= { appointments: [] };
  await db.write();
}

async function saveAppointment(appointment) {
  await db.read();
  db.data.appointments.push(appointment);
  await db.write();
}

async function updateAppointmentById(id, updates) {
  await db.read();
  const appt = db.data.appointments.find((a) => a.id === id);
  if (!appt) return null;
  Object.assign(appt, updates);
  await db.write();
  return appt;
}

async function deleteAppointmentById(id) {
  await db.read();
  const initialLength = db.data.appointments.length;
  db.data.appointments = db.data.appointments.filter((a) => a.id !== id);
  await db.write();
  return db.data.appointments.length !== initialLength;
}

async function getAppointmentsByPhone(phone) {
  await db.read();
  return db.data.appointments
    .filter((a) => a.phone === phone)
    .sort((a, b) => parseDateTime(a.date, a.time) - parseDateTime(b.date, b.time));
}

async function getAppointmentsByDate(date) {
  await db.read();
  return db.data.appointments
    .filter((a) => a.date === date)
    .sort((a, b) => a.time.localeCompare(b.time));
}

async function getTodayAppointments() {
  const now = new Date();
  const today = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  return getAppointmentsByDate(today);
}

async function hasScheduleConflict(date, time, excludeId = null) {
  await db.read();
  return db.data.appointments.some(
    (a) => a.date === date && a.time === time && a.id !== excludeId
  );
}

function resetSession(phone) {
  userSessions.delete(phone);
}

// ═══════════════════════════════════════════════════════
//  FLUXO: AGENDAMENTO
// ═══════════════════════════════════════════════════════

async function handleSchedulingFlow(message, phone, text) {
  const session = userSessions.get(phone);
  if (!session || session.type !== 'scheduling') return false;

  if (text.toLowerCase() === 'cancelar') {
    resetSession(phone);
    await message.reply('❌ Agendamento cancelado.\n\n' + MAIN_MENU);
    return true;
  }

  switch (session.step) {
    case 'specialty': {
      const option = Number(text);
      if (!Number.isInteger(option) || option < 1 || option > SPECIALTIES.length) {
        await message.reply('Número inválido. Escolha uma opção da lista ou *cancelar*.');
        return true;
      }
      session.specialty = SPECIALTIES[option - 1];
      session.step = 'consultation_type'; // 🌟 PRÓXIMO PASSO: Tipo de atendimento
      await message.reply(
        `Especialidade: *${session.specialty}*\n\n` +
        `📍 Como deseja realizar o atendimento?\n\n` +
        `1️⃣ Presencial\n` +
        `2️⃣ Domiciliar\n` +
        `3️⃣ Telemedicina\n\n` +
        `Digite o número da opção desejada:`
      );
      break;
    }
    case 'consultation_type': { // 🌟 PROCESSA TIPO DE CONSULTA INICIALMENTE
      const norm = text.trim();
      if (norm === '1') session.consultationType = 'Presencial';
      else if (norm === '2') session.consultationType = 'Domiciliar';
      else if (norm === '3') session.consultationType = 'Telemedicina';
      else {
        await message.reply('Opção inválida. Escolha:\n1 para Presencial\n2 para Domiciliar\n3 para Telemedicina');
        return true;
      }
      session.step = 'name';
      await message.reply(`Modalidade: *${session.consultationType}*\n\n👤 Informe o *nome completo* do paciente:`);
      break;
    }
    case 'name': {
      if (text.length < 3) {
        await message.reply('Nome inválido. Informe o nome completo:');
        return true;
      }
      session.name = text;
      session.step = 'cpf';
      await message.reply('🪪 Informe o *CPF* do paciente (apenas números):');
      break;
    }
    case 'cpf': {
      const cpfRaw = text.replace(/\D/g, '');
      if (!isValidCPF(cpfRaw)) {
        await message.reply('CPF inválido. Informe um CPF válido (apenas números):');
        return true;
      }
      session.cpf = cpfRaw;
      
      // Se for Telemedicina, o endereço de atendimento físico não é estritamente obrigatório, mas vamos perguntar
      if (session.consultationType === 'Telemedicina') {
        await message.reply('🏠 Para fins de cadastro, informe seu *endereço completo* (ou digite "Não aplicável"):');
      } else {
        await message.reply('🏠 Informe o *endereço completo* para o atendimento (Rua, Número, Bairro/Cidade):');
      }
      session.step = 'address';
      break;
    }
    case 'address': {
      if (text.length < 3) {
        await message.reply('Endereço muito curto. Por favor, detalhe seu endereço completo:');
        return true;
      }
      session.address = text;
      session.step = 'date';
      await message.reply('📅 Informe a *data* desejada no formato *DD/MM/AAAA*:');
      break;
    }
    case 'date': {
      if (!isValidDate(text)) {
        await message.reply('Data inválida. Use *DD/MM/AAAA*:');
        return true;
      }
      if (isDateInPast(text)) {
        await message.reply('⚠️ Data no passado. Informe uma data futura:');
        return true;
      }
      session.date = text;
      session.step = 'time';
      await message.reply('⏰ Informe o *horário* desejado no formato *HH:mm*:');
      break;
    }
    case 'time': {
      if (!isValidTime(text)) {
        await message.reply('Horário inválido. Use *HH:mm* (ex: 14:30):');
        return true;
      }
      if (await hasScheduleConflict(session.date, text)) {
        await message.reply('⚠️ Horário ocupado por outro paciente. Escolha outro:');
        return true;
      }
      const appointment = {
        id: generateId(phone),
        phone,
        name: session.name,
        cpf: session.cpf,
        address: session.address,
        specialty: session.specialty,
        consultationType: session.consultationType, // Já salvo na estrutura
        date: session.date,
        time: text,
        status: 'Agendada',
        createdAt: new Date().toISOString(),
      };
      await saveAppointment(appointment);
      resetSession(phone);
      await message.reply(`✅ *Consulta agendada com sucesso!*\n\n${formatAppointment(appointment)}\n\nAté lá! 😊`);
      break;
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════
//  FLUXO: CANCELAMENTO (REMOÇÃO PERMANENTE)
// ═══════════════════════════════════════════════════════

async function handleCancellationFlow(message, phone, text) {
  const session = userSessions.get(phone);
  if (!session || session.type !== 'cancellation') return false;

  const norm = text.trim().toLowerCase();
  if (norm === '0' || norm === 'cancelar') {
    resetSession(phone);
    await message.reply('↩️ Operação cancelada.\n\n' + MAIN_MENU);
    return true;
  }

  if (session.step === 'select') {
    const index = Number(text) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= session.appointments.length) {
      await message.reply('Número inválido. Digite o número da consulta ou *0* para voltar:');
      return true;
    }
    session.selected = session.appointments[index];
    session.step = 'confirm';
    await message.reply(
      `Confirma a exclusão definitiva do agendamento?\n\n${formatAppointment(session.selected)}\n\nDigite *sim* para apagar ou *não* para voltar.`
    );
    return true;
  }

  if (session.step === 'confirm') {
    if (['sim', 's'].includes(norm)) {
      await deleteAppointmentById(session.selected.id);
      resetSession(phone);
      await message.reply('✅ Consulta concluída com sucesso do sistema.\n\n' + MAIN_MENU);
    } else {
      resetSession(phone);
      await message.reply('↩️ Exclusão não realizada.\n\n' + MAIN_MENU);
    }
    return true;
  }

  return true;
}

// ═══════════════════════════════════════════════════════
//  FLUXO: REAGENDAMENTO
// ═══════════════════════════════════════════════════════

async function handleReschedulingFlow(message, phone, text) {
  const session = userSessions.get(phone);
  if (!session || session.type !== 'rescheduling') return false;

  const norm = text.trim().toLowerCase();
  if (norm === '0' || norm === 'cancelar') {
    resetSession(phone);
    await message.reply('↩️ Operação cancelada.\n\n' + MAIN_MENU);
    return true;
  }

  if (session.step === 'select') {
    const index = Number(text) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= session.appointments.length) {
      await message.reply('Número inválido. Digite o número da consulta ou *0* para voltar:');
      return true;
    }
    session.selected = session.appointments[index];
    session.step = 'date';
    await message.reply(
      `Reagendando: *${session.selected.specialty}* — *${session.selected.name}*\n\n📅 Informe a nova data (*DD/MM/AAAA*) ou *0* para voltar:`
    );
    return true;
  }

  if (session.step === 'date') {
    if (!isValidDate(text)) { await message.reply('Data inválida. Use *DD/MM/AAAA*:'); return true; }
    if (isDateInPast(text)) { await message.reply('⚠️ Data no passado. Informe uma data futura:'); return true; }
    session.newDate = text;
    session.step = 'time';
    await message.reply('⏰ Informe o novo horário (*HH:mm*):');
    return true;
  }

  if (session.step === 'time') {
    if (!isValidTime(text)) { await message.reply('Horário inválido. Use *HH:mm*:'); return true; }
    if (await hasScheduleConflict(session.newDate, text, session.selected.id)) {
      await message.reply('⚠️ Horário ocupado. Escolha outro:');
      return true;
    }
    const updated = await updateAppointmentById(session.selected.id, {
      date: session.newDate, time: text,
      reminderSentAt: null, reminder24hSentAt: null,
      confirmationStatus: null, status: 'Agendada',
    });
    resetSession(phone);
    await message.reply(`✅ *Consulta reagendada!*\n\n${formatAppointment(updated)}`);
    return true;
  }

  return true;
}

// ═══════════════════════════════════════════════════════
//  FLUXO: CONFIRMAÇÃO DE PRESENÇA (lembrete 24h)
// ═══════════════════════════════════════════════════════

async function handlePresenceConfirmationFlow(message, phone, text) {
  const session = userSessions.get(phone);
  if (!session || session.type !== 'presence_confirmation') return false;
  const norm = text.trim().toLowerCase();
  if (['sim', 's', '1'].includes(norm)) {
    await updateAppointmentById(session.appointmentId, { confirmationStatus: 'Confirmada' });
    resetSession(phone);
    await message.reply('✅ Presença confirmada! Aguardamos você. 😊');
  } else if (['não', 'nao', 'n', '2'].includes(norm)) {
    await deleteAppointmentById(session.appointmentId);
    resetSession(phone);
    await message.reply('Entendido. Consulta removida do sistema. Até a próxima! 👋');
  } else {
    await message.reply('Por favor, responda *sim* ou *não*:');
  }
  return true;
}

// ═══════════════════════════════════════════════════════
//  LEMBRETES
// ═══════════════════════════════════════════════════════

async function sendReminder24h(client, appointment) {
  const phone = normalizePhone(appointment.phone);
  const chatId = `${phone}@c.us`;
  try {
    if (!(await client.isRegisteredUser(chatId))) return;
    userSessions.set(phone, { type: 'presence_confirmation', appointmentId: appointment.id });
    await client.sendMessage(chatId,
      `👋 Olá, *${appointment.name}*!\n\nLembrete: sua consulta na modalidade *${appointment.consultationType}* é *amanhã às ${appointment.time}*.\n🩺 ${appointment.specialty}\n\nVocê confirma sua presença?\nResponda *sim* ou *não*.`
    );
    await updateAppointmentById(appointment.id, { reminder24hSentAt: new Date().toISOString() });
  } catch (e) { console.error('[sendReminder24h]', e.message); }
}

async function sendReminder2h(client, appointment) {
  const phone = normalizePhone(appointment.phone);
  const chatId = `${phone}@c.us`;
  try {
    if (!(await client.isRegisteredUser(chatId))) return;
    
    // Como a modalidade já foi coletada, este lembrete de 2h serve como aviso final
    let extraText = appointment.consultationType === 'Telemedicina' 
      ? 'O link para sua chamada de vídeo será enviado minutos antes.'
      : `Lembre-se do local cadastrado: ${appointment.address || 'Clínica Principal'}`;

    await client.sendMessage(chatId,
      `🕐 Olá, *${appointment.name}*!\n\nSua consulta de *${appointment.specialty}* começará em breve (*hoje às ${appointment.time}*).\nModalidade: *${appointment.consultationType}*.\n\n${extraText}\n\nAté logo!`
    );
    await updateAppointmentById(appointment.id, { reminderSentAt: new Date().toISOString() });
  } catch (e) { console.error('[sendReminder2h]', e.message); }
}

async function processAppointmentReminders(client) {
  await db.read();
  const now = new Date();
  for (const appt of db.data.appointments || []) {
    const apptDT = parseDateTime(appt.date, appt.time);
    const msUntil = apptDT - now;
    if (!appt.reminder24hSentAt && msUntil > 23 * 3600000 && msUntil <= 25 * 3600000) {
      await sendReminder24h(client, appt); continue;
    }
    if (!appt.reminderSentAt && msUntil > 0 && msUntil <= 2 * 3600000) {
      await sendReminder2h(client, appt);
    }
  }
}

// ═══════════════════════════════════════════════════════
//  COMANDOS ADMIN
// ═══════════════════════════════════════════════════════

async function handleAdminCommands(message, phone, text) {
  if (!ADMIN_NUMBERS.includes(phone)) return false;
  const trimmed = text.trim();
  const norm = trimmed.toLowerCase();

  if (norm === '/ajuda') { await message.reply(ADMIN_HELP); return true; }

  if (norm === '/agenda' || norm.startsWith('/agenda ')) {
    let list, label;
    if (norm === '/agenda') {
      list = await getTodayAppointments(); label = 'hoje';
    } else {
      const date = trimmed.slice(8).trim();
      if (!isValidDate(date)) { await message.reply('Use: /agenda DD/MM/AAAA'); return true; }
      list = await getAppointmentsByDate(date); label = date;
    }
    await message.reply(
      list.length
        ? `📅 *Agenda de ${label}:*\n\n${list.map((a) => `${a.time} — *${a.name}* | ${a.specialty} (${a.consultationType})`).join('\n')}`
        : `Agenda vazia para ${label}.`
    );
    return true;
  }

  if (norm.startsWith('/buscar ')) {
    const query = trimmed.slice(8).trim();
    const queryNorm = query.toLowerCase();
    const cpfQuery = query.replace(/\D/g, '');
    await db.read();
    const results = db.data.appointments.filter((a) =>
      a.name.toLowerCase().includes(queryNorm) ||
      (cpfQuery.length >= 3 && a.cpf && a.cpf.includes(cpfQuery))
    );
    await message.reply(
      results.length
        ? `🔍 *${results.length} resultado(s) para "${query}":*\n\n${results.map((a) => formatAppointment(a)).join('\n\n──────────\n\n')}`
        : `Nenhum resultado para "${query}".`
    );
    return true;
  }

  if (norm.startsWith('/cancelar ')) {
    const id = trimmed.slice(10).trim();
    const deleted = await deleteAppointmentById(id);
    await message.reply(deleted ? `✅ Registro com o ID ${id} foi permanentemente apagado.` : `ID não encontrado no sistema: ${id}`);
    return true;
  }

  if (norm === '/relatorio') {
    await db.read();
    const all = db.data.appointments;
    const today = await getTodayAppointments();
    const confirmed = all.filter((a) => a.confirmationStatus === 'Confirmada').length;
    await message.reply(
      `📊 *Relatório geral:*\n\n` +
      `Total ativos: ${all.length} | Hoje: ${today.length}\n` +
      `Confirmadas: ${confirmed}\n\n` + ADMIN_HELP
    );
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════

async function handleMessage(client, msg) {
  if (msg.from.includes('@g.us')) return;
  const contact = await msg.getContact();
  const phone = normalizePhone(contact.number);
  const text = (msg.body || '').trim();

  if (await handlePresenceConfirmationFlow(msg, phone, text)) return;
  if (await handleCancellationFlow(msg, phone, text)) return;
  if (await handleReschedulingFlow(msg, phone, text)) return;
  if (await handleSchedulingFlow(msg, phone, text)) return;
  if (await handleAdminCommands(msg, phone, text)) return;

  const norm = text.toLowerCase();

  if (['1', 'agendar'].includes(norm)) {
    userSessions.set(phone, { type: 'scheduling', step: 'specialty' });
    await msg.reply(formatSpecialties()); return;
  }
  if (['2', 'consultas', 'minhas consultas'].includes(norm)) {
    const apps = await getAppointmentsByPhone(phone);
    await msg.reply(apps.length
      ? `📋 *Suas consultas:*\n\n${apps.map((a, i) => formatAppointment(a, i + 1)).join('\n\n──────────\n\n')}`
      : 'Você não possui consultas agendadas.\n\n' + MAIN_MENU
    ); return;
  }
  if (['3', 'cancelar'].includes(norm)) {
    const apps = await getAppointmentsByPhone(phone);
    if (!apps.length) { await msg.reply('Sem consultas para cancelar.\n\n' + MAIN_MENU); return; }
    userSessions.set(phone, { type: 'cancellation', step: 'select', appointments: apps });
    await msg.reply(`Qual consulta deseja cancelar do sistema permanentemente?\n\n${apps.map((a, i) => formatAppointment(a, i + 1)).join('\n\n──────────\n\n')}\n\nDigite o número ou *0* para voltar:`);
    return;
  }
  if (['4', 'reagendar'].includes(norm)) {
    const apps = await getAppointmentsByPhone(phone);
    if (!apps.length) { await msg.reply('Sem consultas para reagendar.\n\n' + MAIN_MENU); return; }
    userSessions.set(phone, { type: 'rescheduling', step: 'select', appointments: apps });
    await msg.reply(`Qual consulta deseja reagendar?\n\n${apps.map((a, i) => formatAppointment(a, i + 1)).join('\n\n──────────\n\n')}\n\nDigite o número ou *0* para voltar:`);
    return;
  }

  await msg.reply(MAIN_MENU);
}

// ═══════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════

async function main() {
  await initDatabase();
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox'] },
  });
  client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
  client.on('ready', () => {
    console.log('✅ Bot conectado.');
    setInterval(() => processAppointmentReminders(client), REMINDER_CHECK_INTERVAL_MS);
  });
  client.on('message', (msg) => handleMessage(client, msg).catch(console.error));
  await client.initialize();

  // Inicializa o Painel Web
  require('./server.js');
}

main().catch(console.error);