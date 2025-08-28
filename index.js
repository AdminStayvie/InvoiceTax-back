require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

const app = express();
const port = process.env.PORT || 3002;
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'taxPlusDB';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Sajikan file dari folder 'public'

if (!mongoUri) {
    console.error("Error: MONGO_URI is not defined in .env file");
    process.exit(1);
}

const client = new MongoClient(mongoUri);
let db, invoicesCollection;

async function startServer() {
    try {
        await client.connect();
        db = client.db(dbName);
        invoicesCollection = db.collection('invoices');
        console.log(`✅ Successfully connected to MongoDB, database: ${dbName}`);
        app.listen(port, () => {
            console.log(`🚀 Server is running on http://localhost:${port}`);
        });
    } catch (e) {
        console.error("❌ Failed to connect to MongoDB and start server", e);
        process.exit(1);
    }
}

// === INVOICES API ===

// GET all invoices with search and pagination
app.get('/api/invoices', async (req, res) => {
    try {
        const { search = '', page = 1, limit = 10 } = req.query;
        const matchStage = search ? { namaKlien: { $regex: search, $options: 'i' } } : {};
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const invoices = await invoicesCollection.find(matchStage)
            .sort({ tanggalInvoice: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .toArray();
            
        const total = await invoicesCollection.countDocuments(matchStage);

        res.json({
            data: invoices,
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(total / parseInt(limit))
        });
    } catch (e) {
        res.status(500).json({ message: "Failed to get invoices", error: e.message });
    }
});

// GET single invoice
app.get('/api/invoices/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });
        const invoice = await invoicesCollection.findOne({ _id: new ObjectId(id) });
        if (!invoice) return res.status(404).json({ message: "Invoice not found" });
        res.json(invoice);
    } catch (e) {
        res.status(500).json({ message: "Failed to get invoice details", error: e.message });
    }
});

// POST new invoice
app.post('/api/invoices', async (req, res) => {
    try {
        const { namaKlien, noTelepon, tanggalInvoice, items } = req.body;
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');

        const lastInvoice = await invoicesCollection.findOne(
            { nomorInvoice: { $regex: `^INV/TP/${year}/${month}/` } },
            { sort: { nomorInvoice: -1 } }
        );

        let nextIdNumber = 1;
        if (lastInvoice) {
            nextIdNumber = parseInt(lastInvoice.nomorInvoice.split('/').pop()) + 1;
        }
        
        const nextId = String(nextIdNumber).padStart(4, '0');
        const nomorInvoice = `INV/TP/${year}/${month}/${nextId}`;

        const newInvoice = {
            _id: new ObjectId(),
            nomorInvoice,
            namaKlien,
            noTelepon,
            tanggalInvoice: new Date(tanggalInvoice),
            items,
            createdAt: new Date(),
        };

        const result = await invoicesCollection.insertOne(newInvoice);
        res.status(201).json({ message: "Invoice created successfully", data: result });
    } catch (e) {
        res.status(500).json({ message: "Failed to create invoice", error: e.message });
    }
});

// DELETE an invoice
app.delete('/api/invoices/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });
        
        const result = await invoicesCollection.deleteOne({ _id: new ObjectId(id) });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Invoice not found" });
        }
        
        res.json({ message: "Invoice deleted successfully" });
    } catch (e) {
        res.status(500).json({ message: "Failed to delete invoice", error: e.message });
    }
});


startServer();
