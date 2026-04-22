import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';

// Load .env
dotenv.config();

const seedAdmin = async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'studio_management',
  });

  try {
    const username = 'admin';
    const password = 'password123'; // ⚠️ You should change this after login!
    
    console.log(`Checking for existing user: ${username}...`);
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);

    if (existing.length > 0) {
      console.log('User already exists. Skipping seed.');
    } else {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      await pool.query(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
        [username, hashedPassword, 'Admin']
      );
      console.log('✅ Admin user created successfully!');
      console.log(`👤 Username: ${username}`);
      console.log(`🔑 Password: ${password}`);
    }
  } catch (err) {
    console.error('❌ Error seeding user:', err.message);
  } finally {
    await pool.end();
  }
};

seedAdmin();
