//src\db.js
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL in .env');
}


const safeDatabaseUrl = process.env.DATABASE_URL.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
console.log('DATABASE_URL used by Node:', safeDatabaseUrl);


export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

export async function testDbConnection() {
    const client = await pool.connect();

    try {
        const result = await client.query('SELECT NOW() as now');
        console.log('PostgreSQL connected:', result.rows[0].now);
    } finally {
        client.release();
    }
}
