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
    // Only if status === 'all' (Admin Dashboard) do we show all statuses.
    // For all public queries, strictly enforce status === 'Approved'.
    if (status === 'all') {
      // Admin dashboard requesting all statuses: do not restrict
    } else if (status) {
      query.status = status;
    } else {
      // Public marketplace: strictly Approved equipment only
      query.status = 'Approved';
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
    if (body.status !== undefined) {
      const validStatuses = ['Pending', 'Approved', 'Rejected'];
      if (!validStatuses.includes(body.status)) {
        return res.status(400).json({ message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      }
      updates.status = body.status;
    }


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

// Update equipment status (Approve / Reject / Pending) - Admin action
app.patch('/api/equipment/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid equipment ID format.' });
    }

    const validStatuses = ['Pending', 'Approved', 'Rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const result = await database.collection('equipment').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );

    if (!result) {
      return res.status(404).json({ message: 'Equipment not found.' });
    }

    return res.status(200).json({
      message: `Equipment status updated to ${status}.`,
      equipment: result,
    });
  } catch (err) {
    console.error('Failed to update equipment status:', err);
    return res.status(500).json({ message: 'Failed to update equipment status.' });
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

// Get single rental booking by ID (used for checkout / payment page)
app.get('/api/rentals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid rental booking ID.' });
    }

    const booking = await database.collection('bookings').findOne({ _id: new ObjectId(id) });
    if (!booking) {
      return res.status(404).json({ message: 'Rental booking not found.' });
    }

    return res.status(200).json(booking);
  } catch (err) {
    console.error('Failed to fetch rental booking by ID:', err);
    return res.status(500).json({ message: 'Failed to fetch rental booking.' });
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

    const reqQty = Number(body.requiredQuantity || body.quantity || 1);
    if (reqQty <= 0) {
      return res.status(400).json({ message: 'Required quantity must be greater than zero.' });
    }

    // Check equipment availability in database
    if (ObjectId.isValid(body.equipmentId)) {
      const equip = await database.collection('equipment').findOne({ _id: new ObjectId(body.equipmentId) });
      if (!equip) {
        return res.status(404).json({ message: 'Equipment item not found.' });
      }
      if (equip.status && equip.status !== 'Approved') {
        return res.status(400).json({ message: 'This equipment is currently not approved for rental.' });
      }
      if (equip.availableQuantity !== undefined && equip.availableQuantity < reqQty) {
        return res.status(400).json({
          message: `Requested quantity (${reqQty}) exceeds currently available stock (${equip.availableQuantity}).`,
        });
      }
    }

    const paymentStatus = String(body.paymentStatus || 'Pending');
    const bookingStatus = String(body.bookingStatus || 'Pending');

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
      requiredQuantity: reqQty,

      // Pricing & Statuses
      rentalPrice: Number(body.rentalPrice || 0),
      rentalType: String(body.rentalType || 'Daily'),
      totalAmount: Number(body.totalAmount || 0),
      paymentStatus: paymentStatus,
      bookingStatus: bookingStatus,
      createdAt: new Date(),
    };

    const insertResult = await database.collection('bookings').insertOne(newBooking);

    // If booking was already marked Paid upfront, decrement quantity
    if (paymentStatus === 'Paid' && ObjectId.isValid(body.equipmentId) && reqQty > 0) {
      try {
        await database.collection('equipment').updateOne(
          { _id: new ObjectId(body.equipmentId), availableQuantity: { $gte: reqQty } },
          { $inc: { availableQuantity: -reqQty } }
        );
      } catch (updateErr) {
        console.warn('Could not decrement availableQuantity for equipment:', updateErr);
      }
    }

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

// POST /api/bookings — Section 7 of Stripe Payment Guide (Save to MongoDB after Stripe payment)
app.post('/api/bookings', async (req, res) => {
  try {
    const body = req.body || {};
    const {
      equipmentId,
      equipmentName,
      customerEmail,
      customerName,
      quantity = 1,
      totalAmount,
      amount,
      transactionId,
      startDate,
      endDate,
      durationDays = 1,
    } = body;

    const txId = String(transactionId || `pi_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`);
    const finalAmount = parseFloat(totalAmount || amount || 0);
    const qty = parseInt(quantity || 1, 10);

    // Idempotency check: prevent duplicate bookings if success page reloaded
    const existingBooking = await database.collection('bookings').findOne({ transactionId: txId });
    if (existingBooking) {
      return res.status(200).json({
        success: true,
        message: 'Booking already recorded for this transaction.',
        booking: existingBooking,
      });
    }

    // 1. Deduct available equipment quantity atomically
    if (ObjectId.isValid(equipmentId) && qty > 0) {
      try {
        await database.collection('equipment').updateOne(
          { _id: new ObjectId(equipmentId), availableQuantity: { $gte: qty } },
          { $inc: { availableQuantity: -qty } }
        );
      } catch (qtyErr) {
        console.warn('Could not decrement equipment quantity:', qtyErr);
      }
    }

    // 2. Insert booking document
    const newBooking = {
      equipmentId: String(equipmentId || ''),
      equipmentName: String(equipmentName || 'Equipment Item'),
      equipmentImage: String(body.equipmentImage || ''),
      equipmentCategory: String(body.category || body.equipmentCategory || 'General'),
      location: String(body.location || ''),
      ownerId: String(body.ownerId || ''),
      ownerName: String(body.ownerName || ''),
      ownerEmail: String(body.ownerEmail || ''),
      customerId: String(body.customerId || ''),
      customerName: String(customerName || 'Customer'),
      customerEmail: String(customerEmail || ''),
      customerPhone: String(body.customerPhone || 'N/A'),
      deliveryAddress: String(body.deliveryAddress || 'N/A'),
      additionalNotes: String(body.additionalNotes || ''),
      startDate: String(startDate || new Date().toISOString().split('T')[0]),
      endDate: String(endDate || new Date().toISOString().split('T')[0]),
      durationDays: Number(durationDays || 1),
      requiredQuantity: qty,
      rentalPrice: Number(body.rentalPrice || 0),
      rentalType: String(body.rentalType || 'Daily'),
      totalAmount: finalAmount,
      transactionId: txId,
      paymentStatus: 'Paid',
      bookingStatus: 'Confirmed',
      paidAt: new Date(),
      createdAt: new Date(),
    };

    const bookingResult = await database.collection('bookings').insertOne(newBooking);
    const bookingId = bookingResult.insertedId.toString();

    // 3. Log payment separately in payments collection
    const paymentRecord = {
      bookingId: bookingId,
      transactionId: txId,
      userEmail: customerEmail,
      customerEmail: customerEmail,
      customerName: customerName,
      equipmentId: String(equipmentId || ''),
      equipmentName: String(equipmentName || ''),
      amount: finalAmount,
      totalAmount: finalAmount,
      paymentMethod: 'Stripe',
      paymentStatus: 'Paid',
      status: 'Completed',
      paidAt: new Date(),
      createdAt: new Date(),
    };

    await database.collection('payments').insertOne(paymentRecord);

    return res.status(201).json({
      success: true,
      message: 'Booking created and payment recorded successfully.',
      booking: { ...newBooking, _id: bookingId },
      payment: paymentRecord,
    });
  } catch (error) {
    console.error('Failed to save booking from Stripe payment:', error);
    return res.status(500).json({ message: error.message || 'Failed to save booking.' });
  }
});

/* =========================================================================
   PAYMENT ROUTES (Stripe & Gateway Integration)
   ========================================================================= */

// Process a payment for a booking
app.post('/api/payments', async (req, res) => {
  try {
    const body = req.body || {};
    const { bookingId, paymentMethod = 'Stripe' } = body;

    if (!bookingId || !ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: 'A valid bookingId is required for payment processing.' });
    }

    const booking = await database.collection('bookings').findOne({ _id: new ObjectId(bookingId) });
    if (!booking) {
      return res.status(404).json({ message: 'Rental booking not found.' });
    }

    if (booking.paymentStatus === 'Paid') {
      return res.status(400).json({ message: 'This booking has already been paid.' });
    }

    // Verify equipment availability before finalizing payment
    if (ObjectId.isValid(booking.equipmentId)) {
      const equip = await database.collection('equipment').findOne({ _id: new ObjectId(booking.equipmentId) });
      if (equip && equip.availableQuantity !== undefined && equip.availableQuantity < booking.requiredQuantity) {
        return res.status(400).json({
          message: `Cannot complete payment: requested units (${booking.requiredQuantity}) exceed available units (${equip.availableQuantity}).`,
        });
      }
    }

    const transactionId =
      body.transactionId ||
      `ch_${Date.now()}_${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

    const paymentRecord = {
      bookingId: String(bookingId),
      equipmentId: String(booking.equipmentId),
      equipmentName: String(booking.equipmentName),
      customerEmail: String(booking.customerEmail),
      customerName: String(booking.customerName),
      ownerEmail: String(booking.ownerEmail || ''),
      totalAmount: Number(body.totalAmount || booking.totalAmount || 0),
      paymentMethod: String(paymentMethod),
      transactionId: transactionId,
      status: 'Completed',
      createdAt: new Date(),
    };

    // Save payment record in payments collection
    const paymentResult = await database.collection('payments').insertOne(paymentRecord);

    // Update booking to Paid & Confirmed
    const updatedBooking = await database.collection('bookings').findOneAndUpdate(
      { _id: new ObjectId(bookingId) },
      {
        $set: {
          paymentStatus: 'Paid',
          bookingStatus: 'Confirmed',
          transactionId: transactionId,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    // Decrement availableQuantity in equipment collection
    if (ObjectId.isValid(booking.equipmentId) && booking.requiredQuantity > 0) {
      try {
        await database.collection('equipment').updateOne(
          { _id: new ObjectId(booking.equipmentId), availableQuantity: { $gte: booking.requiredQuantity } },
          { $inc: { availableQuantity: -booking.requiredQuantity } }
        );
      } catch (equipErr) {
        console.warn('Failed to decrement available quantity during payment:', equipErr);
      }
    }

    return res.status(200).json({
      message: 'Payment completed successfully and booking confirmed.',
      payment: { ...paymentRecord, _id: paymentResult.insertedId.toString() },
      booking: updatedBooking,
    });
  } catch (err) {
    console.error('Failed to process payment:', err);
    return res.status(500).json({ message: 'Failed to process payment.' });
  }
});

// Get payment receipt / details by transactionId or bookingId
app.get('/api/payments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let query;
    if (ObjectId.isValid(id)) {
      query = { $or: [{ _id: new ObjectId(id) }, { bookingId: id }, { transactionId: id }] };
    } else {
      query = { $or: [{ bookingId: id }, { transactionId: id }] };
    }

    const payment = await database.collection('payments').findOne(query);
    if (!payment) {
      return res.status(404).json({ message: 'Payment record not found.' });
    }

    return res.status(200).json(payment);
  } catch (err) {
    console.error('Failed to fetch payment details:', err);
    return res.status(500).json({ message: 'Failed to fetch payment record.' });
  }
});
/* =========================================================================
   USER PROFILE & ADMIN USER MANAGEMENT ROUTES
   ========================================================================= */

// Get all registered users (Admin Oversight)
app.get('/api/users', async (req, res) => {
  try {
    const { search, role } = req.query;
    const query = {};

    // Filter by role if specified
    if (role && role !== 'all') {
      query.role = { $regex: new RegExp(`^${String(role).trim()}$`, 'i') };
    }

    // Filter by search query (name, email, phoneNumber)
    if (search && String(search).trim() !== '') {
      const s = String(search).trim();
      query.$or = [
        { name: { $regex: s, $options: 'i' } },
        { email: { $regex: s, $options: 'i' } },
        { phoneNumber: { $regex: s, $options: 'i' } },
      ];
    }

    // Try 'user' collection first (BetterAuth default)
    let users = await database
      .collection('user')
      .find(query, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray();

    // If empty, also check 'users' collection as fallback
    if (!users || users.length === 0) {
      const fallback = await database
        .collection('users')
        .find(query, { projection: { password: 0 } })
        .sort({ createdAt: -1 })
        .toArray();
      if (fallback && fallback.length > 0) {
        users = fallback;
      }
    }

    // Calculate role metrics
    let customerCount = 0;
    let ownerCount = 0;
    let adminCount = 0;

    users.forEach((u) => {
      const r = (u.role || 'customer').toLowerCase();
      if (r === 'admin') adminCount++;
      else if (r === 'owner') ownerCount++;
      else customerCount++;
    });

    return res.status(200).json({
      users,
      total: users.length,
      counts: {
        total: users.length,
        customer: customerCount,
        owner: ownerCount,
        admin: adminCount,
      },
    });
  } catch (err) {
    console.error('Failed to fetch users:', err);
    return res.status(500).json({ message: 'Failed to fetch registered users.' });
  }
});

// Update user role (Customer, Owner, Admin) — Admin Action
app.patch('/api/users/:id/role', async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body || {};

    if (!role) {
      return res.status(400).json({ message: 'Role is required.' });
    }

    const normalizedRole = String(role).trim().toLowerCase();
    const validRoles = ['customer', 'owner', 'admin'];
    if (!validRoles.includes(normalizedRole)) {
      return res.status(400).json({
        message: `Invalid role. Must be one of: ${validRoles.join(', ')}`,
      });
    }

    let filter;
    if (ObjectId.isValid(id)) {
      filter = { _id: new ObjectId(id) };
    } else {
      filter = { $or: [{ email: id }, { email: id.toLowerCase() }, { id: id }] };
    }

    // Try 'user' collection first
    let result = await database.collection('user').findOneAndUpdate(
      filter,
      { $set: { role: normalizedRole, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { password: 0 } }
    );

    // Fallback to 'users' collection
    if (!result) {
      result = await database.collection('users').findOneAndUpdate(
        filter,
        { $set: { role: normalizedRole, updatedAt: new Date() } },
        { returnDocument: 'after', projection: { password: 0 } }
      );
    }

    if (!result) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.status(200).json({
      message: `User role updated to ${normalizedRole}.`,
      user: result,
    });
  } catch (err) {
    console.error('Failed to update user role:', err);
    return res.status(500).json({ message: 'Failed to update user role.' });
  }
});

// Manage user details (Update name, phone, address, status, role) — Admin Action
app.patch('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) updates.name = String(body.name).trim();
    if (body.phoneNumber !== undefined) updates.phoneNumber = String(body.phoneNumber).trim();
    if (body.address !== undefined) updates.address = String(body.address).trim();
    if (body.image !== undefined) updates.image = String(body.image).trim();
    if (body.status !== undefined) updates.status = String(body.status).trim();

    if (body.role !== undefined) {
      const normalizedRole = String(body.role).trim().toLowerCase();
      if (['customer', 'owner', 'admin'].includes(normalizedRole)) {
        updates.role = normalizedRole;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid update fields provided.' });
    }

    updates.updatedAt = new Date();

    let filter;
    if (ObjectId.isValid(id)) {
      filter = { _id: new ObjectId(id) };
    } else {
      filter = { $or: [{ email: id }, { email: id.toLowerCase() }, { id: id }] };
    }

    let result = await database.collection('user').findOneAndUpdate(
      filter,
      { $set: updates },
      { returnDocument: 'after', projection: { password: 0 } }
    );

    if (!result) {
      result = await database.collection('users').findOneAndUpdate(
        filter,
        { $set: updates },
        { returnDocument: 'after', projection: { password: 0 } }
      );
    }

    if (!result) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.status(200).json({
      message: 'User updated successfully.',
      user: result,
    });
  } catch (err) {
    console.error('Failed to update user:', err);
    return res.status(500).json({ message: 'Failed to update user.' });
  }
});

// Delete user — Admin Action
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let filter;
    if (ObjectId.isValid(id)) {
      filter = { _id: new ObjectId(id) };
    } else {
      filter = { $or: [{ email: id }, { email: id.toLowerCase() }, { id: id }] };
    }

    let result = await database.collection('user').deleteOne(filter);
    if (result.deletedCount === 0) {
      result = await database.collection('users').deleteOne(filter);
    }

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.status(200).json({
      message: 'User deleted successfully.',
      id,
    });
  } catch (err) {
    console.error('Failed to delete user:', err);
    return res.status(500).json({ message: 'Failed to delete user.' });
  }
});


// Get user profile by email or user ID
app.get('/api/users/profile/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) {
      return res.status(400).json({ message: 'User email is required.' });
    }


    const query = {
      $or: [
        { email: email },
        { email: email.toLowerCase() },
      ],
    };


    // If param is a valid ObjectId, check _id as well
    if (ObjectId.isValid(email)) {
      query.$or.push({ _id: new ObjectId(email) });
    }


    const user = await database.collection('user').findOne(query);
    if (!user) {
      return res.status(404).json({ message: 'User profile not found.' });
    }


    const { password, ...safeUser } = user;
    return res.status(200).json(safeUser);
  } catch (err) {
    console.error('Failed to fetch user profile:', err);
    return res.status(500).json({ message: 'Failed to fetch user profile.' });
  }
});


// Update user profile by email
app.put('/api/users/profile/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) {
      return res.status(400).json({ message: 'User email is required.' });
    }


    const body = req.body || {};
    const updates = {};


    if (body.name !== undefined) updates.name = String(body.name).trim();
    if (body.image !== undefined) updates.image = String(body.image).trim();
    if (body.phoneNumber !== undefined) updates.phoneNumber = String(body.phoneNumber).trim();
    if (body.address !== undefined) updates.address = String(body.address).trim();


    updates.updatedAt = new Date();


    const query = {
      $or: [
        { email: email },
        { email: email.toLowerCase() },
      ],
    };


    if (ObjectId.isValid(email)) {
      query.$or.push({ _id: new ObjectId(email) });
    }


    const result = await database.collection('user').findOneAndUpdate(
      query,
      { $set: updates },
      { returnDocument: 'after' }
    );


    if (!result) {
      return res.status(404).json({ message: 'User profile not found.' });
    }


    const { password, ...safeUser } = result;
    return res.status(200).json({
      message: 'Profile updated successfully.',
      user: safeUser,
    });
  } catch (err) {
    console.error('Failed to update user profile:', err);
    return res.status(500).json({ message: 'Failed to update user profile.' });
  }
});
/* =========================================================================
   FAVORITES ROUTES
   ========================================================================= */


// Get all favorites for a customer by email
app.get('/api/favorites/:email', async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) {
      return res.status(400).json({ message: 'User email is required.' });
    }


    const favorites = await database
      .collection('favorites')
      .find({
        $or: [
          { userEmail: email },
          { userEmail: email.toLowerCase() },
          { userId: email },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();


    return res.status(200).json(favorites);
  } catch (err) {
    console.error('Failed to fetch favorites:', err);
    return res.status(500).json({ message: 'Failed to fetch favorites.' });
  }
});


// Check if specific equipment is in customer's favorites
app.get('/api/favorites/check/:email/:equipmentId', async (req, res) => {
  try {
    const { email, equipmentId } = req.params;
    if (!email || !equipmentId) {
      return res.status(400).json({ message: 'Email and equipmentId are required.' });
    }


    const favorite = await database.collection('favorites').findOne({
      $or: [
        { userEmail: email },
        { userEmail: email.toLowerCase() },
        { userId: email },
      ],
      equipmentId: String(equipmentId),
    });


    return res.status(200).json({
      isFavorite: Boolean(favorite),
      favoriteId: favorite ? favorite._id.toString() : null,
    });
  } catch (err) {
    console.error('Failed to check favorite status:', err);
    return res.status(500).json({ message: 'Failed to check favorite status.' });
  }
});


// Add equipment to favorites
app.post('/api/favorites', async (req, res) => {
  try {
    const {
      userEmail,
      userId,
      equipmentId,
      equipmentName,
      category,
      rentalPrice,
      rentalType,
      location,
      availableQuantity,
      image,
      brand,
      model,
      description,
      ownerName,
      ownerEmail,
    } = req.body || {};


    if (!userEmail || !equipmentId) {
      return res.status(400).json({ message: 'User email and equipmentId are required.' });
    }


    // Check if already favorited
    const existing = await database.collection('favorites').findOne({
      $or: [
        { userEmail: userEmail },
        { userEmail: userEmail.toLowerCase() },
        { userId: userId || userEmail },
      ],
      equipmentId: String(equipmentId),
    });


    if (existing) {
      return res.status(200).json({
        message: 'Equipment is already in your favorites.',
        favorite: existing,
      });
    }


    const newFavorite = {
      userEmail: String(userEmail),
      userId: String(userId || ''),
      equipmentId: String(equipmentId),
      equipmentName: String(equipmentName || 'Equipment'),
      category: String(category || 'General'),
      rentalPrice: Number(rentalPrice || 0),
      rentalType: String(rentalType || 'Daily'),
      location: String(location || ''),
      availableQuantity: Number(availableQuantity || 1),
      image: String(image || ''),
      brand: String(brand || ''),
      model: String(model || ''),
      description: String(description || ''),
      ownerName: String(ownerName || ''),
      ownerEmail: String(ownerEmail || ''),
      createdAt: new Date(),
    };


    const insertResult = await database.collection('favorites').insertOne(newFavorite);
    return res.status(201).json({
      message: 'Equipment added to favorites.',
      id: insertResult.insertedId.toString(),
      favorite: { ...newFavorite, _id: insertResult.insertedId.toString() },
    });
  } catch (err) {
    console.error('Failed to add favorite:', err);
    return res.status(500).json({ message: 'Failed to add favorite.' });
  }
});


// Remove favorite by favorite ID
app.delete('/api/favorites/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid favorite ID format.' });
    }


    const result = await database.collection('favorites').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Favorite item not found.' });
    }


    return res.status(200).json({
      message: 'Favorite removed successfully.',
      id,
    });
  } catch (err) {
    console.error('Failed to remove favorite:', err);
    return res.status(500).json({ message: 'Failed to remove favorite.' });
  }
});


// Remove favorite by email & equipmentId
app.delete('/api/favorites/item/:email/:equipmentId', async (req, res) => {
  try {
    const { email, equipmentId } = req.params;
    if (!email || !equipmentId) {
      return res.status(400).json({ message: 'Email and equipmentId are required.' });
    }


    const result = await database.collection('favorites').deleteOne({
      $or: [
        { userEmail: email },
        { userEmail: email.toLowerCase() },
        { userId: email },
      ],
      equipmentId: String(equipmentId),
    });


    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Favorite item not found.' });
    }


    return res.status(200).json({
      message: 'Favorite removed successfully.',
    });
  } catch (err) {
    console.error('Failed to remove favorite:', err);
    return res.status(500).json({ message: 'Failed to remove favorite.' });
  }
});


app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
