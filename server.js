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
      
      if (projects.length > 0) {
          const projectIds = projects.map(p => p.id);
          
          const [allServices] = await pool.query('SELECT project_id, service_name FROM project_services WHERE project_id IN (?)', [projectIds]);
          const servicesMap = {};
          allServices.forEach(s => {
            if (!servicesMap[s.project_id]) servicesMap[s.project_id] = [];
            servicesMap[s.project_id].push(s.service_name);
          });
          
          const [allAssignments] = await pool.query('SELECT project_id, member_id FROM project_assignments WHERE project_id IN (?)', [projectIds]);
          const assignmentsMap = {};
          allAssignments.forEach(a => {
            if (!assignmentsMap[a.project_id]) assignmentsMap[a.project_id] = [];
            assignmentsMap[a.project_id].push(a.member_id.toString());
          });

          for (let p of projects) {
              p.selectedServices = servicesMap[p.id] || [];
              p.assignedTeam = assignmentsMap[p.id] || [];
              p.date = p.event_date; // Map for frontend
              p.daysOfProgram = p.days_of_program;
              p.teamPrice = p.team_price;
              p.editorPrice = p.editor_price;
              p.albumPrice = p.album_price;
              p.startTime = p.start_time;
          }
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
    if (projects.length > 0) {
        const projectIds = projects.map(p => p.id);
        
        const [allServices] = await pool.query('SELECT project_id, service_name FROM project_services WHERE project_id IN (?)', [projectIds]);
        const servicesMap = {};
        allServices.forEach(s => {
          if (!servicesMap[s.project_id]) servicesMap[s.project_id] = [];
          servicesMap[s.project_id].push(s.service_name);
        });
        
        const [allAssignments] = await pool.query('SELECT project_id, member_id FROM project_assignments WHERE project_id IN (?)', [projectIds]);
        const assignmentsMap = {};
        allAssignments.forEach(a => {
          if (!assignmentsMap[a.project_id]) assignmentsMap[a.project_id] = [];
          assignmentsMap[a.project_id].push(a.member_id.toString());
        });

        for (let p of projects) {
            p.selectedServices = servicesMap[p.id] || [];
            p.assignedTeam = assignmentsMap[p.id] || [];
            p.date = p.event_date; // Map for frontend
            p.daysOfProgram = p.days_of_program;
            p.teamPrice = p.team_price;
            p.editorPrice = p.editor_price;
            p.albumPrice = p.album_price;
            p.startTime = p.start_time;
        }
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

    // 🛑 Prevent Duplicates (Check if same title/date exists for this client)
    const [existing] = await connection.query(
      'SELECT id FROM projects WHERE client_id = ? AND title = ? AND event_date = ?',
      [clientID, p.title, p.date]
    );
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(200).json({ success: true, id: existing[0].id, message: 'Project already exists' });
    }

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
    
    // Exhaustive map of all standard fields sent by ClientDetails.jsx
    const fieldMap = {
        title: 'title', date: 'event_date', status: 'status', 
        daysOfProgram: 'days_of_program', teamPrice: 'team_price',
        dataFromTeam: 'data_from_team', venue: 'venue', startTime: 'start_time', 
        budget: 'budget', deadline: 'deadline',
        
        // New Tracking & Workflow Fields
        dataFromClient: 'dataFromClient', dataToStudio: 'dataToStudio',
        deliveryDeadline: 'deliveryDeadline', clientMsgSent: 'clientMsgSent',
        editorMsgSent: 'editorMsgSent', dataToEditor: 'dataToEditor',
        deadlineDate: 'deadlineDate', editorPrice: 'editor_price', 
        reelsCount: 'reelsCount', albumRequired: 'albumRequired', 
        designerMsgSent: 'designerMsgSent', dataToDesigner: 'dataToDesigner', 
        albumDeadline: 'albumDeadline', albumPrice: 'album_price', 
        happyMsgSent: 'happyMsgSent', msg1Sent: 'msg1Sent', msg2Sent: 'msg2Sent'
    };

    for (let [key, column] of Object.entries(fieldMap)) {
        if (p[key] !== undefined) {
            let val = p[key];
            
            // Fix for empty strings causing MySQL strict mode errors
            if (val === '') {
                if (key.includes('date') || key.toLowerCase().includes('deadline') || key.includes('Date')) {
                    val = null; // Empty dates should be NULL
                } else if (key.toLowerCase().includes('price') || key === 'budget' || key === 'reelsCount' || key === 'daysOfProgram') {
                    val = 0; // Empty numeric fields should be 0
                }
            }

            updateFields.push(`${column} = ?`);
            values.push(val);
        }
    }

    // Handle Editor Assignment (First item in array -> editor_id)
    if (p.assignedEditor !== undefined) {
        updateFields.push('editor_id = ?');
        values.push(p.assignedEditor.length > 0 && p.assignedEditor[0] ? p.assignedEditor[0] : null);
    }

    // Handle Designer Assignment (First item in array -> album_artist_id)
    if (p.assignedDesigner !== undefined) {
        updateFields.push('album_artist_id = ?');
        values.push(p.assignedDesigner.length > 0 && p.assignedDesigner[0] ? p.assignedDesigner[0] : null);
    }

    // Handle Schedule Array (Serialize to JSON)
    if (p.schedule !== undefined) {
        updateFields.push('shoot_custom_dates = ?');
        values.push(JSON.stringify(p.schedule));
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
    
    // Update Editing Services
    if (p.editingServices !== undefined) {
        // Here we could save them to project_services or a new table, but for now we'll rely on the existing schema if it supports it,
        // or just let the main workflow continue without crashing. 
        // Note: project_services handles Deliverables. If editingServices should be saved, they can be merged into project_services.
    }

    // Update Assignments (Team Leader / Crew)
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
            'INSERT INTO clients (name, phone, email, address, notes, category) VALUES (?, ?, ?, ?, ?, ?)',
            [name, phone, email, address, notes, category || 'Other']
        );
        res.status(201).json({ id: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.put('/api/clients/:id', async (req, res) => {
    const { id } = req.params;
    const { name, phone, email, address, notes, category } = req.body;
    try {
        await pool.query(
            'UPDATE clients SET name = ?, phone = ?, email = ?, address = ?, notes = ?, category = ? WHERE id = ?',
            [name, phone, email, address, notes, category, id]
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
        const [rows] = await pool.query(`
            SELECT i.*, c.name as clientName 
            FROM invoices i 
            LEFT JOIN clients c ON i.client_id = c.id 
            ORDER BY i.invoice_date DESC
        `);
        
        if (rows.length > 0) {
            const invoiceIds = rows.map(inv => inv.id);
            const [allItems] = await pool.query('SELECT * FROM invoice_items WHERE invoice_id IN (?)', [invoiceIds]);
            
            const itemsMap = {};
            allItems.forEach(item => {
                if (!itemsMap[item.invoice_id]) itemsMap[item.invoice_id] = [];
                itemsMap[item.invoice_id].push(item);
            });

            for (let inv of rows) {
                inv.items = itemsMap[inv.id] || [];
                inv.client = { name: inv.clientName || 'Unknown' };
                
                // Fix double prefix for invoice number
                let num = inv.invoice_number || '';
                if (num.startsWith('#INV-')) num = num.substring(5);
                else if (num.startsWith('INV-')) num = num.substring(4);

                // Compute total dynamically if it is null or 0 in DB
                let computedTotal = parseFloat(inv.total_amount) || 0;
                if (!computedTotal && inv.items.length > 0) {
                    const sub = inv.items.reduce((s, i) => s + (parseFloat(i.rate) || 0) * (parseInt(i.qty) || 0), 0);
                    const tax = sub * ((parseFloat(inv.tax_amount) || 0) / 100);
                    computedTotal = sub + tax;
                }

                // Map db columns to frontend expectations
                inv.number = num;
                inv.date = inv.invoice_date;
                inv.amount = computedTotal;
                inv.total = computedTotal;
                inv.taxRate = inv.tax_amount;
                inv.tax = inv.tax_amount;
                inv.discount = inv.discount_amount;
                inv.amountPaid = inv.paid_amount;
                inv.paidAmount = inv.paid_amount;
                
                delete inv.clientName;
            }
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

        // Find or Create Client ID
        let clientID = null;
        if (inv.client && inv.client.name) {
            const [clients] = await connection.query('SELECT id FROM clients WHERE name = ?', [inv.client.name]);
            if (clients.length > 0) {
                clientID = clients[0].id;
            } else {
                const [newClient] = await connection.query(
                    'INSERT INTO clients (name, phone, email, address, gst_number) VALUES (?, ?, ?, ?, ?)',
                    [inv.client.name, inv.client.phone || null, inv.client.email || null, inv.client.address || null, inv.client.gstin || null]
                );
                clientID = newClient.insertId;
            }
        }

        if (!clientID) {
            const [fallback] = await connection.query('INSERT INTO clients (name) VALUES ("Unknown Client")');
            clientID = fallback.insertId;
        }

        const [result] = await connection.query(
            'INSERT INTO invoices (invoice_number, client_id, invoice_date, total_amount, tax_amount, discount_amount, paid_amount, status, notes, deliverables) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [inv.number, clientID, inv.date, inv.total, inv.tax, inv.discount, inv.paidAmount, inv.status, inv.notes, inv.deliverables || '']
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
        console.error('Invoice POST Error:', err);
        res.status(500).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Invoice number already exists' : 'Database error' });
    } finally {
        connection.release();
    }
});

app.put('/api/invoices/:id', async (req, res) => {
    const { id } = req.params;
    const inv = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Update Client (or find existing)
        let clientID = null;
        if (inv.client && inv.client.name) {
            const [clients] = await connection.query('SELECT id FROM clients WHERE name = ?', [inv.client.name]);
            if (clients.length > 0) {
                clientID = clients[0].id;
                await connection.query(
                    'UPDATE clients SET phone = ?, email = ?, address = ?, gst_number = ? WHERE id = ?',
                    [inv.client.phone || null, inv.client.email || null, inv.client.address || null, inv.client.gstin || null, clientID]
                );
            } else {
                const [newClient] = await connection.query(
                    'INSERT INTO clients (name, phone, email, address, gst_number) VALUES (?, ?, ?, ?, ?)',
                    [inv.client.name, inv.client.phone || null, inv.client.email || null, inv.client.address || null, inv.client.gstin || null]
                );
                clientID = newClient.insertId;
            }
        }

        // 2. Update Invoice
        await connection.query(
            'UPDATE invoices SET invoice_number = ?, client_id = ?, invoice_date = ?, total_amount = ?, tax_amount = ?, discount_amount = ?, paid_amount = ?, status = ?, notes = ?, deliverables = ? WHERE id = ?',
            [inv.number, clientID, inv.date, inv.total, inv.tax, inv.discount, inv.paidAmount, inv.status, inv.notes, inv.deliverables || '', id]
        );

        // 3. Update Items (Delete and re-insert)
        await connection.query('DELETE FROM invoice_items WHERE invoice_id = ?', [id]);
        if (inv.items && inv.items.length > 0) {
            const itemValues = inv.items.map(item => [id, item.description, item.rate, item.qty, (item.rate * item.qty)]);
            await connection.query('INSERT INTO invoice_items (invoice_id, description, rate, qty, amount) VALUES ?', [itemValues]);
        }

        await connection.commit();
        res.json({ success: true });
    } catch (err) {
        await connection.rollback();
        console.error('Invoice PUT Error:', err);
        res.status(500).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Invoice number already exists' : 'Database error' });
    } finally {
        connection.release();
    }
});

app.delete('/api/invoices/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM invoices WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Invoice DELETE Error:', err);
        res.status(500).json({ error: 'Database error' });
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

// 🧹 10. ADMIN CLEANUP (Temporary)
app.get('/api/admin/master-cleanup', async (req, res) => {
    try {
        // Remove empty dates
        await pool.query('DELETE FROM projects WHERE event_date IS NULL OR event_date = "" OR event_date = "0000-00-00"');
        // Remove duplicates
        await pool.query('DELETE p1 FROM projects p1 INNER JOIN projects p2 WHERE p1.id > p2.id AND p1.client_id = p2.client_id AND p1.title = p2.title AND p1.event_date = p2.event_date');
        res.json({ success: true, message: 'Database cleaned!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🚀 Studio API running on port ${PORT}`);
});
