require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const fs = require('fs');

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
let db, hotelInvoicesCollection, taxplusInvoicesCollection;

// Helper function to get the correct collection based on type
function getCollection(type) {
    return type === 'hotel' ? hotelInvoicesCollection : taxplusInvoicesCollection;
}

// Function to ensure placeholder logo for Stay.vie exists
function ensureStayvieLogo() {
    const publicDir = path.join(__dirname, 'public');
    const taxplusLogoPath = path.join(publicDir, 'Logo.png');
    const stayvieLogoPath = path.join(publicDir, 'Logo_stayvie.png');

    if (fs.existsSync(taxplusLogoPath) && !fs.existsSync(stayvieLogoPath)) {
        fs.copyFileSync(taxplusLogoPath, stayvieLogoPath);
        console.log('✅ Created placeholder Logo_stayvie.png');
    }
}


async function startServer() {
    try {
        await client.connect();
        db = client.db(dbName);
        hotelInvoicesCollection = db.collection('hotel_invoices');
        taxplusInvoicesCollection = db.collection('taxplus_invoices');
        console.log(`✅ Successfully connected to MongoDB, database: ${dbName}`);
        
        ensureStayvieLogo();

        app.listen(port, () => {
            console.log(`🚀 Server is running on http://localhost:${port}`);
        });
    } catch (e) {
        console.error("❌ Failed to connect to MongoDB and start server", e);
        process.exit(1);
    }
}

// === INVOICES API ===

// GET all invoices by type with search and pagination
app.get('/api/invoices/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const collection = getCollection(type);
        if (!collection) return res.status(400).json({ message: "Invalid invoice type" });

        const { search = '', page = 1, limit = 10 } = req.query;
        const matchStage = search ? { namaKlien: { $regex: search, $options: 'i' } } : {};
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const invoices = await collection.find(matchStage)
            .sort({ tanggalInvoice: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .toArray();
            
        const total = await collection.countDocuments(matchStage);

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

// GET single invoice by type
app.get('/api/invoices/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        const collection = getCollection(type);
        if (!collection) return res.status(400).json({ message: "Invalid invoice type" });

        if (!ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });
        const invoice = await collection.findOne({ _id: new ObjectId(id) });
        if (!invoice) return res.status(404).json({ message: "Invoice not found" });
        res.json(invoice);
    } catch (e) {
        res.status(500).json({ message: "Failed to get invoice details", error: e.message });
    }
});

// POST new invoice by type
app.post('/api/invoices/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const collection = getCollection(type);
        if (!collection) return res.status(400).json({ message: "Invalid invoice type" });

        const { namaKlien, noTelepon, tanggalInvoice, items, downPayment = 0 } = req.body;
        
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');

        const prefix = type === 'hotel' ? `INV/SV` : `INV/TP`;
        
        const lastInvoice = await collection.findOne(
            { nomorInvoice: { $regex: `^${prefix}/${year}/${month}/` } },
            { sort: { nomorInvoice: -1 } }
        );

        let nextIdNumber = 1;
        if (lastInvoice && lastInvoice.nomorInvoice) {
            const lastId = lastInvoice.nomorInvoice.split('/').pop();
            nextIdNumber = parseInt(lastId) + 1;
        }
        
        const nextId = String(nextIdNumber).padStart(4, '0');
        const nomorInvoice = `${prefix}/${year}/${month}/${nextId}`;

        const totalAmount = items.reduce((sum, item) => sum + (item.total || 0), 0);
        let status = 'belum lunas';
        const payments = [];

        if (downPayment > 0) {
            payments.push({
                amount: parseFloat(downPayment),
                date: new Date(tanggalInvoice),
                notes: 'Uang Muka (DP)'
            });
            if (downPayment >= totalAmount) {
                status = 'lunas';
            } else {
                status = 'dp lunas';
            }
        }


        const newInvoice = {
            _id: new ObjectId(),
            nomorInvoice,
            namaKlien,
            noTelepon,
            tanggalInvoice: new Date(tanggalInvoice),
            items,
            payments,
            type,
            status: status,
            createdAt: new Date(),
        };

        const result = await collection.insertOne(newInvoice);
        res.status(201).json({ message: "Invoice created successfully", data: result.insertedId });
    } catch (e) {
        res.status(500).json({ message: "Failed to create invoice", error: e.message });
    }
});

// POST a new payment to an invoice
app.post('/api/invoices/:type/:id/payment', async (req, res) => {
    try {
        const { type, id } = req.params;
        const { amount, date, notes } = req.body;
        const collection = getCollection(type);

        if (!collection) return res.status(400).json({ message: "Invalid invoice type" });
        if (!ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });
        if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid payment amount" });

        const invoice = await collection.findOne({ _id: new ObjectId(id) });
        if (!invoice) return res.status(404).json({ message: "Invoice not found" });

        const newPayment = {
            amount: parseFloat(amount),
            date: date ? new Date(date) : new Date(),
            notes: notes || 'Pembayaran'
        };

        const updateResult = await collection.updateOne(
            { _id: new ObjectId(id) },
            { $push: { payments: newPayment } }
        );
        
        if(updateResult.modifiedCount === 0) {
             return res.status(500).json({ message: "Failed to add payment" });
        }
        
        const updatedInvoice = await collection.findOne({ _id: new ObjectId(id) });
        const totalAmount = updatedInvoice.items.reduce((sum, item) => sum + (item.total || 0), 0);
        const totalPaid = updatedInvoice.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
        
        let newStatus = 'belum lunas';
        if (totalPaid >= totalAmount) {
            newStatus = 'lunas';
        } else if (totalPaid > 0) {
            newStatus = 'dp lunas';
        }
        
        await collection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: newStatus } }
        );

        res.status(200).json({ message: "Payment added successfully", status: newStatus });

    } catch (e) {
        res.status(500).json({ message: "Failed to add payment", error: e.message });
    }
});

// PATCH invoice status by type
app.patch('/api/invoices/:type/:id/status', async (req, res) => {
    try {
        const { type, id } = req.params;
        const { status } = req.body;
        const collection = getCollection(type);
        const validStatuses = ['lunas', 'belum lunas', 'dp lunas'];

        if (!collection) {
            return res.status(400).json({ message: "Invalid invoice type" });
        }
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid ID" });
        }
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: "Invalid status value" });
        }

        const result = await collection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: status } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Invoice not found" });
        }

        res.json({ message: "Invoice status updated successfully" });
    } catch (e) {
        res.status(500).json({ message: "Failed to update invoice status", error: e.message });
    }
});


// DELETE an invoice by type
app.delete('/api/invoices/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        const collection = getCollection(type);
        if (!collection) return res.status(400).json({ message: "Invalid invoice type" });

        if (!ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });
        
        const result = await collection.deleteOne({ _id: new ObjectId(id) });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Invoice not found" });
        }
        
        res.json({ message: "Invoice deleted successfully" });
    } catch (e) {
        res.status(500).json({ message: "Failed to delete invoice", error: e.message });
    }
});

startServer();

