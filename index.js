const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const SPECIALTIES = [
  'Clínico Geral',
  'Cardiologia',
  'Dermatologia',
  'Endocrinologia',
  'Ginecologia',
  'Neurologia',
  'Ortopedia',
  'Pediatria',
  'Psiquiatria',
  'Psicologia'
];

const ADMIN_NUMBER = '5542999262497';
const DB_FILE = './db.json';
const userSessions = new Map();

const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter, {
  appointments: []
});

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function getContactNumber(chatId) {
  return normalizePhone(String(chatId || '').split('@')[0]);
}

function isValidDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);

  if (!match) {
    return false;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);

  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function isValidTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);

  if (!match) {
    return false;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

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
  return [
    `📅 ${appointment.date}`,
    `⏰ ${appointment.time}`,
    `👤 ${appointment.name}`,
    `Especialidade: ${appointment.specialty}`
  ].join('\n');
}

async function initDatabase() {
  await db.read();
  db.data ||= { appointments: [] };
  db.data.appointments ||= [];
  await db.write();
}

async function saveAppointment(appointment) {
  db.data.appointments.push(appointment);
  await db.write();
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
  const today = [
    String(now.getDate()).padStart(2, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    now.getFullYear()
  ].join('/');

  return db.data.appointments
    .filter((appointment) => appointment.date === today)
    .sort((a, b) => a.time.localeCompare(b.time));
}

async function hasScheduleConflict(date, time) {
  await db.read();

  return db.data.appointments.some(
    (appointment) => appointment.date === date && appointment.time === time
  );
}

function resetSession(phone) {
  userSessions.delete(phone);
}

function startScheduleSession(phone) {
  userSessions.set(phone, {
    step: 'specialty'
  });
}

async function handleSchedulingFlow(message, phone, text) {
  const session = userSessions.get(phone);

  if (!session) {
    return false;
  }

  if (text.toLowerCase() === 'cancelar') {
    resetSession(phone);
    await message.reply('Atendimento cancelado com sucesso. Quando quiser, envie *agendar* para iniciar novamente.');
    return true;
  }

  if (session.step === 'specialty') {
    const option = Number(text);

    if (!Number.isInteger(option) || option < 1 || option > SPECIALTIES.length) {
      await message.reply('Número inválido. Informe uma opção da lista para escolher a especialidade.');
      return true;
    }

    session.specialty = SPECIALTIES[option - 1];
    session.step = 'name';

    await message.reply(`Especialidade selecionada: *${session.specialty}*.\n\n👤 Informe o nome completo do paciente.`);
    return true;
  }

  if (session.step === 'name') {
    if (text.length < 3) {
      await message.reply('Por favor, informe um nome válido com pelo menos 3 caracteres.');
      return true;
    }

    session.name = text;
    session.step = 'date';

    await message.reply('📅 Informe a data da consulta no formato *DD/MM/YYYY*.');
    return true;
  }

  if (session.step === 'date') {
    if (!isValidDate(text)) {
      await message.reply('Data inválida. Use o formato *DD/MM/YYYY* e informe uma data existente.');
      return true;
    }

    const appointmentDate = parseDateTime(text, '00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (appointmentDate < today) {
      await message.reply('A data informada já passou. Envie uma data atual ou futura no formato *DD/MM/YYYY*.');
      return true;
    }

    session.date = text;
    session.step = 'time';

    await message.reply('⏰ Informe o horário desejado no formato *HH:mm*.');
    return true;
  }

  if (session.step === 'time') {
    if (!isValidTime(text)) {
      await message.reply('Horário inválido. Use o formato *HH:mm*, por exemplo: *14:30*.');
      return true;
    }

    const conflict = await hasScheduleConflict(session.date, text);

    if (conflict) {
      await message.reply('Esse horário já está reservado para a data informada. Escolha outro horário, por favor.');
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

    await message.reply(
      [
        'Consulta agendada com sucesso.',
        '',
        formatAppointment(appointment),
        '',
        'Se desejar consultar seus agendamentos, envie *consultas*.'
      ].join('\n')
    );
    return true;
  }

  return false;
}

async function handleStartScheduling(message, phone) {
  startScheduleSession(phone);
  await message.reply(
    [
      'Olá! Vamos iniciar seu agendamento.',
      '',
      formatSpecialties(),
      '',
      'Se quiser interromper o processo, envie *cancelar*.'
    ].join('\n')
  );
}

async function handleUserAppointments(message, phone) {
  const appointments = await getAppointmentsByPhone(phone);

  if (appointments.length === 0) {
    await message.reply('Você não possui consultas agendadas no momento.');
    return;
  }

  const lines = appointments.map((appointment, index) => {
    return `${index + 1}.\n${formatAppointment(appointment)}`;
  });

  await message.reply(`📅 *Suas consultas agendadas:*\n\n${lines.join('\n\n')}`);
}

async function handleAdminAgenda(message, phone) {
  if (phone !== ADMIN_NUMBER) {
    await message.reply('Este comando é restrito ao número autorizado da clínica.');
    return;
  }

  const appointments = await getTodayAppointments();

  if (appointments.length === 0) {
    await message.reply('📅 Não há consultas agendadas para hoje.');
    return;
  }

  const lines = appointments.map((appointment, index) => {
    return [
      `${index + 1}. ⏰ ${appointment.time}`,
      `👤 ${appointment.name}`,
      `Especialidade: ${appointment.specialty}`,
      `Contato: ${appointment.phone}`
    ].join('\n');
  });

  await message.reply(`📅 *Agenda de hoje:*\n\n${lines.join('\n\n')}`);
}

async function main() {
  await initDatabase();

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    console.log('Escaneie o QR Code abaixo para conectar o WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('Bot conectado e pronto para uso.');
  });

  client.on('auth_failure', (error) => {
    console.error('Falha na autenticação do WhatsApp:', error);
  });

  client.on('disconnected', (reason) => {
    console.warn('Cliente desconectado:', reason);
  });

  client.on('message', async (message) => {
    try {
      if (message.from.includes('@g.us')) {
        return;
      }

      const phone = getContactNumber(message.from);
      const text = String(message.body || '').trim();
      const normalizedText = text.toLowerCase();

      if (!text) {
        return;
      }

      const handledByFlow = await handleSchedulingFlow(message, phone, text);

      if (handledByFlow) {
        return;
      }

      if (normalizedText === 'agendar') {
        await handleStartScheduling(message, phone);
        return;
      }

      if (normalizedText === 'consultas') {
        await handleUserAppointments(message, phone);
        return;
      }

      if (normalizedText === '/agenda') {
        await handleAdminAgenda(message, phone);
        return;
      }

      if (normalizedText === 'ajuda' || normalizedText === 'menu') {
        await message.reply(
          [
            'Olá! Posso ajudar com os seguintes comandos:',
            '',
            '• *agendar* - iniciar novo agendamento',
            '• *consultas* - listar suas consultas',
            '• */agenda* - agenda do dia (somente administração)'
          ].join('\n')
        );
      }
    } catch (error) {
      console.error('Erro ao processar mensagem:', error);
      await message.reply('Ocorreu um erro ao processar sua solicitação. Tente novamente em instantes.');
    }
  });

  await client.initialize();
}

main().catch((error) => {
  console.error('Erro ao iniciar o bot:', error);
});
