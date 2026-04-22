import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 🟢 QUICK DEBUG ROUTE (To test if server is running on Render)
app.get('/', (req, res) => {
  res.send('API is running 🚀');
});

const JWT_SECRET = process.env.JWT_SECRET || 'surya_studio_fallback_secret';

// 🔐 AUTH MIDDLEWARE
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Access denied. Token missing.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
        req.user = user;
        next();
    });
};

// 🔑 LOGIN ENDPOINT
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        if (users.length === 0) return res.status(401).json({ error: 'Invalid username or password' });

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) return res.status(401).json({ error: 'Invalid username or password' });

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: { id: user.id, username: user.username, role: user.role }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error during login' });
    }
});

// 🗄️ MySQL Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'studio_management',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 👤 1. GET ALL CLIENTS
app.get('/api/clients', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM clients ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 📁 1.5 GET ALL PROJECTS
app.get('/api/all-projects', async (req, res) => {
    try {
      const [projects] = await pool.query(`
        SELECT p.*, c.name as clientName FROM projects p 
        JOIN clients c ON p.client_id = c.id 
        ORDER BY p.event_date DESC`);
      
      for (let p of projects) {
          const [services] = await pool.query('SELECT service_name FROM project_services WHERE project_id = ?', [p.id]);
          p.selectedServices = services.map(s => s.service_name);
          
          const [assignments] = await pool.query('SELECT member_id FROM project_assignments WHERE project_id = ?', [p.id]);
          p.assignedTeam = assignments.map(a => a.member_id.toString());
      }
  
      res.json(projects);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
});

// 📁 2. GET PROJECTS FOR A CLIENT
app.get('/api/projects/:clientName', async (req, res) => {
  const { clientName } = req.params;
  try {
    // Join with project_services for a complete view
    const [projects] = await pool.query(`
      SELECT p.* FROM projects p 
      JOIN clients c ON p.client_id = c.id 
      WHERE c.name = ?`, [clientName]);
    
    // Fetch services and assignments for each project
    for (let p of projects) {
        const [services] = await pool.query('SELECT service_name FROM project_services WHERE project_id = ?', [p.id]);
        p.selectedServices = services.map(s => s.service_name);
        
        const [assignments] = await pool.query('SELECT member_id FROM project_assignments WHERE project_id = ?', [p.id]);
        p.assignedTeam = assignments.map(a => a.member_id.toString());
    }

    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ➕ 3. SAVE NEW PROJECT
app.post('/api/projects', async (req, res) => {
  const p = req.body;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Find Client ID
    const [clients] = await connection.query('SELECT id FROM clients WHERE name = ?', [p.clientName]);
    if (clients.length === 0) throw new Error('Client not found');
    const clientID = clients[0].id;

    // Insert Project
    const [result] = await connection.query(
      `INSERT INTO projects (
        client_id, title, event_date, status, days_of_program, venue, start_time, budget, deadline
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [clientID, p.title, p.date, p.status, p.daysOfProgram, p.venue, p.startTime, p.budget, p.deadline]
    );
    const projectID = result.insertId;

    // Insert Services
    if (p.selectedServices && p.selectedServices.length > 0) {
      const serviceValues = p.selectedServices.map(s => [projectID, s]);
      await connection.query('INSERT INTO project_services (project_id, service_name) VALUES ?', [serviceValues]);
    }

    await connection.commit();
    res.status(201).json({ success: true, id: projectID });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

// 🔄 4. UPDATE PROJECT
app.put('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  const p = req.body;
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    // Update main project table
    const updateFields = [];
    const values = [];
    const fieldMap = {
        title: 'title', date: 'event_date', status: 'status', 
        daysOfProgram: 'days_of_program', teamPrice: 'team_price',
        dataFromTeam: 'data_from_team', editorID: 'editor_id',
        venue: 'venue', startTime: 'start_time', budget: 'budget',
        deadline: 'deadline', shootCustomDates: 'shoot_custom_dates'
    };

    for (let [key, column] of Object.entries(fieldMap)) {
        if (p[key] !== undefined) {
            updateFields.push(`${column} = ?`);
            values.push(p[key]);
        }
    }

    if (updateFields.length > 0) {
        values.push(id);
        await connection.query(`UPDATE projects SET ${updateFields.join(', ')} WHERE id = ?`, values);
    }

    // Update Services (delete and re-insert for simplicity)
    if (p.selectedServices !== undefined) {
        await connection.query('DELETE FROM project_services WHERE project_id = ?', [id]);
        if (p.selectedServices.length > 0) {
            const serviceValues = p.selectedServices.map(s => [id, s]);
            await connection.query('INSERT INTO project_services (project_id, service_name) VALUES ?', [serviceValues]);
        }
    }

    // Update Assignments
    if (p.assignedTeam !== undefined) {
        await connection.query('DELETE FROM project_assignments WHERE project_id = ?', [id]);
        if (p.assignedTeam.length > 0) {
            const assignmentValues = p.assignedTeam.map(mid => [id, mid]);
            await connection.query('INSERT INTO project_assignments (project_id, member_id) VALUES ?', [assignmentValues]);
        }
    }

    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    connection.release();
  }
});

// 🗑️ 5. DELETE PROJECT
app.get('/api/projects/delete/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM projects WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 👤 6. CLIENTS CRUD
app.post('/api/clients', async (req, res) => {
    const { name, phone, email, address, notes, category } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO clients (name, phone, email, address, notes) VALUES (?, ?, ?, ?, ?)',
            [name, phone, email, address, notes]
        );
        res.status(201).json({ id: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.put('/api/clients/:id', async (req, res) => {
    const { id } = req.params;
    const { name, phone, email, address, notes } = req.body;
    try {
        await pool.query(
            'UPDATE clients SET name = ?, phone = ?, email = ?, address = ?, notes = ? WHERE id = ?',
            [name, phone, email, address, notes, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/clients/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM clients WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 🧾 7. INVOICES
app.get('/api/invoices', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM invoices ORDER BY invoice_date DESC');
        for (let inv of rows) {
            const [items] = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = ?', [inv.id]);
            inv.items = items;
            
            // Get client name for frontend compatibility
            const [clients] = await pool.query('SELECT name FROM clients WHERE id = ?', [inv.client_id]);
            inv.client = { name: clients[0]?.name || 'Unknown' };
        }
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/invoices', async (req, res) => {
    const inv = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Find Client ID
        const [clients] = await connection.query('SELECT id FROM clients WHERE name = ?', [inv.client?.name]);
        const clientID = clients[0]?.id || null;

        const [result] = await connection.query(
            'INSERT INTO invoices (invoice_number, client_id, invoice_date, total_amount, tax_amount, discount_amount, paid_amount, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [inv.number, clientID, inv.date, inv.total, inv.tax, inv.discount, inv.paidAmount, inv.status, inv.notes]
        );
        const invoiceID = result.insertId;

        if (inv.items && inv.items.length > 0) {
            const itemValues = inv.items.map(item => [invoiceID, item.description, item.rate, item.qty, (item.rate * item.qty)]);
            await connection.query('INSERT INTO invoice_items (invoice_id, description, rate, qty, amount) VALUES ?', [itemValues]);
        }

        await connection.commit();
        res.status(201).json({ id: invoiceID });
    } catch (err) {
        await connection.rollback();
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        connection.release();
    }
});

// 👥 8. TEAM MEMBERS
app.get('/api/team', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM team_members ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/team', async (req, res) => {
  const { name, role, phone, email, image_url, daily_rate } = req.body;
  try {
    const [result] = await pool.query(
      'INSERT INTO team_members (name, role, phone, email, image_url, daily_rate) VALUES (?, ?, ?, ?, ?, ?)',
      [name, role, phone, email, image_url, daily_rate]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/team/:id', async (req, res) => {
  const { id } = req.params;
  const { name, role, phone, email, image_url, daily_rate, status } = req.body;
  try {
    await pool.query(
      'UPDATE team_members SET name = ?, role = ?, phone = ?, email = ?, image_url = ?, daily_rate = ?, status = ? WHERE id = ?',
      [name, role, phone, email, image_url, daily_rate, status, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/team/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM team_members WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 📝 9. STUDIO NOTES
app.get('/api/notes', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM studio_notes ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/notes', async (req, res) => {
  const { title, content, category } = req.body;
  try {
    const [result] = await pool.query(
      'INSERT INTO studio_notes (title, content, category) VALUES (?, ?, ?)',
      [title, content, category]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/notes/:id', async (req, res) => {
    const { id } = req.params;
    const { title, content, category } = req.body;
    try {
        await pool.query(
            'UPDATE studio_notes SET title = ?, content = ?, category = ? WHERE id = ?',
            [title, content, category, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/notes/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM studio_notes WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🚀 Studio API running on port ${PORT}`);
});
