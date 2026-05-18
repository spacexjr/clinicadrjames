const express = require('express');
const cors = require('cors');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const app = express();
const PORT = 3000;

// Configuração do Banco de Dados (Mesmo arquivo do Bot)
const adapter = new JSONFile('./db.json');
const db = new Low(adapter, { appointments: [] });

app.use(cors());
app.use(express.json());

// Helper para formatar CPF na listagem
function formatCPF(cpf) {
  cpf = String(cpf || '').replace(/\D/g, '');
  return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

/**
 * 🌐 ROTA PRINCIPAL: Serve a interface visual (HTML/CSS/JS)
 */
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Painel de Agendamentos - Clínica</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 font-sans antialiased">
      
      <nav class="bg-blue-600 p-4 text-white shadow-md">
        <div class="container mx-auto flex justify-between items-center">
          <h1 class="text-xl font-bold flex items-center gap-2">Docs 🩺 Painel da Clínica</h1>
          <span class="bg-blue-700 px-3 py-1 rounded text-sm font-medium">Agenda Ativa</span>
        </div>
      </nav>

      <main class="container mx-auto p-4 md:p-8">
        <div class="bg-white rounded-lg shadow p-6">
          <div class="flex justify-between items-center mb-6">
            <h2 class="text-xl font-semibold text-gray-800">Próximas Consultas</h2>
            <button onclick="fetchAppointments()" class="bg-gray-200 hover:bg-gray-300 text-gray-700 px-3 py-1.5 rounded text-sm transition font-medium">🔄 Atualizar</button>
          </div>

          <div class="overflow-x-auto">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Data/Hora</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Paciente</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Especialidade</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Endereço</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Modos / Presença</th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Ações</th>
                </tr>
              </thead>
              <tbody id="agenda-corpo" class="bg-white divide-y divide-gray-200">
                </tbody>
            </table>
          </div>
        </div>
      </main>

      <script>
        async function fetchAppointments() {
          try {
            const res = await fetch('/api/appointments');
            const appointments = await res.json();
            const tbody = document.getElementById('agenda-corpo');
            tbody.innerHTML = '';

            if(appointments.length === 0) {
              tbody.innerHTML = '<tr><td colspan="7" class="px-6 py-8 text-center text-gray-500">Nenhum agendamento ativo encontrado no sistema.</td></tr>';
              return;
            }

            appointments.forEach(appt => {
              const tr = document.createElement('tr');
              const presence = appt.confirmationStatus ? \` (\${appt.confirmationStatus})\` : '';
              const addressText = appt.address ? appt.address : '<span class="text-gray-400 italic">Não exige / Não informado</span>';

              tr.innerHTML = \`
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">\${appt.date} às \${appt.time}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  <div class="font-semibold text-gray-700">\${appt.name}</div>
                  <div class="text-xs text-gray-400">CPF: \${appt.formattedCPF}</div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">\${appt.specialty}</td>
                <td class="px-6 py-4 text-sm text-gray-600 max-w-xs break-words">\${addressText}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-medium text-blue-600">\${appt.consultationType || 'Não definido'}<span class="text-xs text-gray-400 font-normal">\${presence}</span></td>
                <td class="px-6 py-4 whitespace-nowrap text-sm">
                  <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">\${appt.status || 'Agendada'}</span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-center text-sm font-medium">
                  <button onclick="deleteAppointment('\${appt.id}')" class="text-red-600 hover:text-red-900 bg-red-50 hover:bg-red-100 px-3 py-1 rounded transition">Apagar</button>
                </td>
              \`;
              tbody.appendChild(tr);
            });
          } catch (err) {
            console.error('Erro ao buscar dados:', err);
          }
        }

        async function deleteAppointment(id) {
          if (!confirm('Tem certeza de que deseja APAGAR permanentemente esta consulta do sistema?')) return;
          try {
            const res = await fetch(\`/api/appointments/\${id}\`, { method: 'DELETE' });
            if (res.ok) {
              alert('Consulta deletada com sucesso!');
              fetchAppointments();
            } else {
              alert('Erro ao deletar consulta.');
            }
          } catch (err) {
            alert('Erro de conexão com o servidor.');
          }
        }

        // Carrega ao iniciar a página
        window.onload = fetchAppointments;
      </script>
    </body>
    </html>
  `);
});

/**
 * 📊 API: Listar todos os agendamentos ativos ordenados pelos criados recentemente
 */
app.get('/api/appointments', async (req, res) => {
  await db.read();
  const appointments = db.data.appointments || [];
  
  const list = appointments
    .map(a => ({ ...a, formattedCPF: formatCPF(a.cpf) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    
  res.json(list);
});

/**
 * 🗑️ API: Apagar definitivamente uma consulta pelo ID
 */
app.delete('/api/appointments/:id', async (req, res) => {
  const { id } = req.params;
  await db.read();
  
  const initialLength = db.data.appointments.length;
  db.data.appointments = db.data.appointments.filter((a) => a.id !== id);
  
  if (db.data.appointments.length === initialLength) {
    return res.status(404).json({ error: 'Consulta não encontrada.' });
  }

  await db.write();
  res.json({ success: true, message: 'Consulta excluída do banco de dados com sucesso.' });
});

// Inicialização do Servidor Express
app.listen(PORT, () => {
  console.log(`🌐 Painel Web rodando com sucesso em: http://localhost:${PORT}`);
});