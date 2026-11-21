import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const app = express();
const port = process.env.PORT || 5000;

//middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-4ksem3f-shard-00-00.ohhbrll.mongodb.net:27017,ac-4ksem3f-shard-00-01.ohhbrll.mongodb.net:27017,ac-4ksem3f-shard-00-02.ohhbrll.mongodb.net:27017/?ssl=true&replicaSet=atlas-mwgrqy-shard-0&authSource=admin`);

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}
const connectedClient = await connectToMongoDB();
const database = connectedClient.db("rentoradb");
app.get('/', (req, res) => {
  res.send('Hello World!');
});

const rentalTypes = ['Daily', 'Weekly', 'Monthly'];

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

app.post('/api/equipment', async (req, res) => {
  const body = req.body || {};
  const requiredFields = {
    ownerId: body.ownerId,
    ownerName: body.ownerName,
    ownerEmail: body.ownerEmail,
    equipmentName: body.equipmentName,
    description: body.description,
    category: body.category,
    location: body.location,
    rentalPrice: body.rentalPrice,
    rentalType: body.rentalType,
    availableQuantity: body.availableQuantity,
    equipmentCondition: body.equipmentCondition,
    brand: body.brand,
    model: body.model,
    image: body.image,
    rentalTerms: body.rentalTerms,
  };

  const missing = Object.entries(requiredFields)
    .filter(([, value]) => isBlank(value))
    .map(([field]) => field);

  if (missing.length > 0) {
    return res.status(400).json({
      message: `Missing required fields: ${missing.join(', ')}`,
    });
  }

  const rentalPrice = Number(body.rentalPrice);
  const availableQuantity = Number(body.availableQuantity);

  if (!Number.isFinite(rentalPrice) || rentalPrice <= 0) {
    return res.status(400).json({ message: 'Rental price must be greater than zero.' });
  }

  if (!Number.isInteger(availableQuantity) || availableQuantity < 1) {
    return res.status(400).json({
      message: 'Available quantity must be a whole number of at least 1.',
    });
  }

  if (!rentalTypes.includes(body.rentalType)) {
    return res.status(400).json({ message: 'Invalid rental type.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.ownerEmail))) {
    return res.status(400).json({ message: 'Invalid owner email.' });
  }

  const equipment = {
    ownerId: String(body.ownerId),
    ownerName: String(body.ownerName),
    ownerEmail: String(body.ownerEmail),
    equipmentName: String(body.equipmentName),
    description: String(body.description),
    category: String(body.category),
    location: String(body.location),
    rentalPrice,
    rentalType: body.rentalType,
    availableQuantity,
    equipmentCondition: String(body.equipmentCondition),
    brand: String(body.brand),
    model: String(body.model),
    image: String(body.image),
    rentalTerms: String(body.rentalTerms),
    status: 'Pending',
    createdAt: new Date(),
  };

  try {
    const result = await database.collection('equipment').insertOne(equipment);
    return res.status(201).json({
      message: 'Equipment submitted for review.',
      id: result.insertedId.toString(),
      equipment: { ...equipment, _id: result.insertedId.toString() },
    });
  } catch (err) {
    console.error('Failed to add equipment:', err);
    return res.status(500).json({ message: 'Failed to add equipment.' });
  }
});

// Get all equipment added by a specific owner (by route param)
app.get('/api/equipment/owner/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) {
      return res.status(400).json({ message: 'Owner email is required.' });
    }

    const items = await database
      .collection('equipment')
      .find({
        $or: [
          { ownerEmail: email },
          { ownerId: email },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json(items);
  } catch (err) {
    console.error('Failed to fetch owner equipment:', err);
    return res.status(500).json({ message: 'Failed to fetch equipment.' });
  }
});

// Get all equipment added by a specific owner (by query params)
app.get('/api/equipment/owner', async (req, res) => {
  try {
    const email = req.query.email ? String(req.query.email) : null;
    const ownerId = req.query.ownerId ? String(req.query.ownerId) : null;

    if (!email && !ownerId) {
      return res.status(400).json({ message: 'Owner email or ownerId query parameter is required.' });
    }

    const conditions = [];
    if (email) conditions.push({ ownerEmail: email });
    if (ownerId) conditions.push({ ownerId: ownerId });

    const query = conditions.length > 1 ? { $or: conditions } : conditions[0];

    const items = await database
      .collection('equipment')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json(items);
  } catch (err) {
    console.error('Failed to fetch owner equipment:', err);
    return res.status(500).json({ message: 'Failed to fetch equipment.' });
  }
});




app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});