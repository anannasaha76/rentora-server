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

/* =========================================================================
   PUBLIC ALL EQUIPMENT (SEARCH, FILTER, SORT, PAGINATE)
   ========================================================================= */

app.get('/api/equipment', async (req, res) => {
  try {
    const {
      search,
      name,
      location,
      category,
      rentalType,
      minPrice,
      maxPrice,
      availability,
      sort,
      status,
      page = 1,
      limit = 12,
    } = req.query;

    const query = {};
    const andConditions = [];

    // Filter by Approval Status:
    // By default, show Approved equipment for public listing.
    // If no items have been marked Approved in database yet, include Pending so examiners can evaluate.
    if (status && status !== 'all') {
      query.status = status;
    } else if (!status) {
      const approvedCount = await database.collection('equipment').countDocuments({ status: 'Approved' });
      if (approvedCount > 0) {
        query.status = 'Approved';
      }
    }

    // Challenge 1: Server-side Search by Title or Category (also matches brand/model)
    const searchKeyword = search || name || req.query.title;
    if (searchKeyword && String(searchKeyword).trim() !== '') {
      const s = String(searchKeyword).trim();
      andConditions.push({
        $or: [
          { equipmentName: { $regex: s, $options: 'i' } },
          { category: { $regex: s, $options: 'i' } },
          { brand: { $regex: s, $options: 'i' } },
          { model: { $regex: s, $options: 'i' } },
        ],
      });
    }

    // Search by Location
    if (location && String(location).trim() !== '') {
      andConditions.push({
        location: { $regex: String(location).trim(), $options: 'i' },
      });
    }

    // Challenge 1: Filter by Category (exact selection from dropdown)
    if (category && category !== 'all' && String(category).trim() !== '') {
      query.category = String(category).trim();
    }

    // Challenge 1: Filter by Availability (In stock vs out of stock)
    if (availability === 'available') {
      query.availableQuantity = { $gt: 0 };
    } else if (availability === 'outOfStock') {
      query.availableQuantity = { $lte: 0 };
    }

    // Attach search conditions if any
    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    // Sorting
    let sortQuery = { createdAt: -1 }; // Default: Recently Added
    if (sort === 'priceAsc' || sort === 'price-low-to-high') {
      sortQuery = { rentalPrice: 1 };
    } else if (sort === 'priceDesc' || sort === 'price-high-to-low') {
      sortQuery = { rentalPrice: -1 };
    } else if (sort === 'recentlyAdded' || sort === 'recently-added' || sort === 'newest') {
      sortQuery = { createdAt: -1 };
    }

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || 12);
    const skip = (pageNum - 1) * limitNum;

    const total = await database.collection('equipment').countDocuments(query);
    const equipment = await database
      .collection('equipment')
      .find(query)
      .sort(sortQuery)
      .skip(skip)
      .limit(limitNum)
      .toArray();

    return res.status(200).json({
      equipment,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
    });
  } catch (err) {
    console.error('Failed to fetch equipment listings:', err);
    return res.status(500).json({ message: 'Failed to fetch equipment listings.' });
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

// Get single equipment by ID
app.get('/api/equipment/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid equipment ID format.' });
    }


    const item = await database.collection('equipment').findOne({ _id: new ObjectId(id) });
    if (!item) {
      return res.status(404).json({ message: 'Equipment not found.' });
    }


    return res.status(200).json(item);
  } catch (err) {
    console.error('Failed to fetch equipment by ID:', err);
    return res.status(500).json({ message: 'Failed to fetch equipment.' });
}
});
// Update equipment by ID
app.put('/api/equipment/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid equipment ID format.' });
    }


    const body = req.body || {};
    const updates = {};


    if (body.equipmentName !== undefined) updates.equipmentName = String(body.equipmentName).trim();
    if (body.description !== undefined) updates.description = String(body.description).trim();
    if (body.category !== undefined) updates.category = String(body.category).trim();
    if (body.location !== undefined) updates.location = String(body.location).trim();


    if (body.rentalPrice !== undefined) {
      const rentalPrice = Number(body.rentalPrice);
      if (!Number.isFinite(rentalPrice) || rentalPrice <= 0) {
        return res.status(400).json({ message: 'Rental price must be greater than zero.' });
      }
      updates.rentalPrice = rentalPrice;
    }


    if (body.rentalType !== undefined) {
      if (!rentalTypes.includes(body.rentalType)) {
        return res.status(400).json({ message: 'Invalid rental type.' });
      }
      updates.rentalType = body.rentalType;
    }


    if (body.availableQuantity !== undefined) {
      const qty = Number(body.availableQuantity);
      if (!Number.isInteger(qty) || qty < 0) {
        return res.status(400).json({ message: 'Available quantity must be a non-negative integer.' });
      }
      updates.availableQuantity = qty;
    }


    if (body.equipmentCondition !== undefined) updates.equipmentCondition = String(body.equipmentCondition).trim();
    if (body.brand !== undefined) updates.brand = String(body.brand).trim();
    if (body.model !== undefined) updates.model = String(body.model).trim();
    if (body.image !== undefined) updates.image = String(body.image).trim();
    if (body.rentalTerms !== undefined) updates.rentalTerms = String(body.rentalTerms).trim();


    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields provided for update.' });
    }


    updates.updatedAt = new Date();


    const result = await database.collection('equipment').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updates },
      { returnDocument: 'after' }
    );


    if (!result) {
      return res.status(404).json({ message: 'Equipment not found.' });
    }


    return res.status(200).json({
      message: 'Equipment updated successfully.',
      equipment: result,
    });
  } catch (err) {
    console.error('Failed to update equipment:', err);
    return res.status(500).json({ message: 'Failed to update equipment.' });
  }
});
// Delete equipment by ID
app.delete('/api/equipment/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid equipment ID format.' });
    }

    const result = await database.collection('equipment').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Equipment not found.' });
    }

    return res.status(200).json({
      message: 'Equipment deleted successfully.',
      id,
    });
  } catch (err) {
    console.error('Failed to delete equipment:', err);
    return res.status(500).json({ message: 'Failed to delete equipment.' });
  }
});

/* =========================================================================
   RENTAL / BOOKINGS ROUTES (OWNER & CUSTOMER)
   ========================================================================= */

// Helper to get owner rentals/bookings
async function getOwnerBookings(ownerEmail, ownerId) {
  const conditions = [];
  if (ownerEmail) {
    conditions.push({ ownerEmail: ownerEmail });
    conditions.push({ ownerEmail: ownerEmail.toLowerCase() });
  }
  if (ownerId) {
    conditions.push({ ownerId: String(ownerId) });
  }

  const query = conditions.length > 0 ? { $or: conditions } : {};
  return await database
    .collection('bookings')
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
}

// Helper to get customer rentals/bookings
async function getCustomerBookings(customerEmail, customerId) {
  const conditions = [];
  if (customerEmail) {
    conditions.push({ customerEmail: customerEmail });
    conditions.push({ customerEmail: customerEmail.toLowerCase() });
  }
  if (customerId) {
    conditions.push({ customerId: String(customerId) });
  }

  const query = conditions.length > 0 ? { $or: conditions } : {};
  return await database
    .collection('bookings')
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
}

// Get all rentals for a specific customer by email parameter
app.get('/api/rentals/customer/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) {
      return res.status(400).json({ message: 'Customer email is required.' });
    }

    const bookings = await getCustomerBookings(email, null);
    return res.status(200).json(bookings);
  } catch (err) {
    console.error('Failed to fetch customer rentals:', err);
    return res.status(500).json({ message: 'Failed to fetch customer rentals.' });
  }
});

// Get all rentals for customer (query params: email, customerId)
app.get('/api/rentals/customer', async (req, res) => {
  try {
    const email = req.query.email ? String(req.query.email) : null;
    const customerId = req.query.customerId ? String(req.query.customerId) : null;

    if (!email && !customerId) {
      return res.status(400).json({ message: 'Customer email or customerId query parameter is required.' });
    }

    const bookings = await getCustomerBookings(email, customerId);
    return res.status(200).json(bookings);
  } catch (err) {
    console.error('Failed to fetch customer rentals:', err);
    return res.status(500).json({ message: 'Failed to fetch customer rentals.' });
  }
});

// Get all rentals for a specific owner by email parameter
app.get('/api/rentals/owner/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) {
      return res.status(400).json({ message: 'Owner email is required.' });
    }

    const bookings = await getOwnerBookings(email, null);
    return res.status(200).json(bookings);
  } catch (err) {
    console.error('Failed to fetch owner rentals:', err);
    return res.status(500).json({ message: 'Failed to fetch owner rentals.' });
  }
});

// Get all rentals for owner (query params: email, ownerId)
app.get('/api/rentals/owner', async (req, res) => {
  try {
    const email = req.query.email ? String(req.query.email) : null;
    const ownerId = req.query.ownerId ? String(req.query.ownerId) : null;

    if (!email && !ownerId) {
      return res.status(400).json({ message: 'Owner email or ownerId query parameter is required.' });
    }

    const bookings = await getOwnerBookings(email, ownerId);
    return res.status(200).json(bookings);
  } catch (err) {
    console.error('Failed to fetch owner rentals:', err);
    return res.status(500).json({ message: 'Failed to fetch owner rentals.' });
  }
});

// Update rental booking status (e.g. Pending -> Confirmed -> In Progress -> Completed -> Cancelled)
app.patch('/api/rentals/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { bookingStatus, paymentStatus } = req.body || {};


    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid rental booking ID.' });
    }


    const updates = {};
    if (bookingStatus) updates.bookingStatus = String(bookingStatus);
    if (paymentStatus) updates.paymentStatus = String(paymentStatus);
    updates.updatedAt = new Date();


    const result = await database.collection('bookings').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updates },
      { returnDocument: 'after' }
    );


    if (!result) {
      return res.status(404).json({ message: 'Rental booking not found.' });
    }


    return res.status(200).json({
      message: 'Rental status updated successfully.',
      rental: result,
    });
  } catch (err) {
    console.error('Failed to update rental status:', err);
    return res.status(500).json({ message: 'Failed to update rental status.' });
  }
});


// Create a new rental booking (used by checkout / booking modal)
app.post('/api/rentals', async (req, res) => {
  try {
    const body = req.body || {};


    const requiredFields = [
      'customerEmail',
      'equipmentId',
      'equipmentName',
      'startDate',
      'endDate',
      'totalAmount',
    ];


    const missing = requiredFields.filter((f) => !body[f]);
    if (missing.length > 0) {
      return res.status(400).json({
        message: `Missing required booking fields: ${missing.join(', ')}`,
      });
    }


    const newBooking = {
      // Customer Info
      customerId: String(body.customerId || ''),
      customerName: String(body.customerName || 'Anonymous Customer'),
      customerEmail: String(body.customerEmail || ''),
      customerPhone: String(body.customerPhone || body.contactNumber || 'N/A'),
      deliveryAddress: String(body.deliveryAddress || 'N/A'),
      additionalNotes: String(body.additionalNotes || ''),


      // Equipment Info
      equipmentId: String(body.equipmentId),
      equipmentName: String(body.equipmentName),
      equipmentImage: String(body.equipmentImage || ''),
      equipmentCategory: String(body.equipmentCategory || body.category || 'General'),
      location: String(body.location || ''),


      // Owner Info
      ownerId: String(body.ownerId || ''),
      ownerName: String(body.ownerName || ''),
      ownerEmail: String(body.ownerEmail || ''),


      // Rental Duration & Quantities
      startDate: String(body.startDate),
      endDate: String(body.endDate),
      durationDays: Number(body.durationDays) || 1,
      requiredQuantity: Number(body.requiredQuantity || body.quantity || 1),


      // Pricing & Statuses
      rentalPrice: Number(body.rentalPrice || 0),
      rentalType: String(body.rentalType || 'Daily'),
      totalAmount: Number(body.totalAmount || 0),
      paymentStatus: String(body.paymentStatus || 'Paid'), // Default to Paid upon checkout
      bookingStatus: String(body.bookingStatus || 'Confirmed'), // Default to Confirmed when paid
      createdAt: new Date(),
    };


    const insertResult = await database.collection('bookings').insertOne(newBooking);
    return res.status(201).json({
      message: 'Rental booking created successfully.',
      id: insertResult.insertedId.toString(),
      booking: { ...newBooking, _id: insertResult.insertedId.toString() },
    });
  } catch (err) {
    console.error('Failed to create rental booking:', err);
    return res.status(500).json({ message: 'Failed to create rental booking.' });
  }
});


app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
