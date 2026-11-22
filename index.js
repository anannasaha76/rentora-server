import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { jwtVerify, createRemoteJWKSet } from 'jose'

const app = express();
const port = process.env.PORT || 5000;

//middleware
app.use(express.json());
app.use(cors());
const authOrigin = (
  process.env.CLIENT_URL ||
  process.env.BETTER_AUTH_URL ||
  process.env.NEXT_PUBLIC_BETTER_AUTH_URL ||
  'http://localhost:3000'
).replace(/\/+$/, '');

const JWKS = createRemoteJWKSet(new URL(`${authOrigin}/api/auth/jwks`));

const unauthorized = (res, error = 'Unauthorized: Sign-in required.') =>
  res.status(401).json({ success: false, error });

const forbidden = (
  res,
  error = 'Forbidden: You do not have permission to perform this action.'
) => res.status(403).json({ success: false, error });

const verifyToken = async (req, res, next) => {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return unauthorized(res);
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    return next();
  } catch {
    return unauthorized(res, 'Unauthorized: Invalid or expired token.');
  }
};

const getRole = (req) =>
  String(req.user?.role || req.user?.user?.role || 'customer').toLowerCase();

const getUserId = (req) => req.user?.id || req.user?.sub;

const getUserEmail = (req) => String(req.user?.email || '').toLowerCase();

const verifyRole = (...roles) => (req, res, next) => {
  const role = getRole(req);
  if (roles.includes(role) || role === 'admin') return next();
  return forbidden(res, `Forbidden: ${roles.join(' or ')} access required.`);
};

const verifyRenter = verifyRole('customer', 'renter');
const verifyOwner = verifyRole('owner');
const verifyAdmin = verifyRole('admin');

const verifySelf = (req, res, next) => {
  if (getRole(req) === 'admin') return next();

  const identities = [
    req.params?.email,
    req.query?.email,
    req.query?.customerId,
    req.query?.ownerId,
    req.body?.customerEmail,
    req.body?.userEmail,
    req.body?.customerId,
    req.body?.userId,
  ]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => String(value));

  const userId = getUserId(req) == null ? null : String(getUserId(req));
  const email = getUserEmail(req);
  const isOwnIdentity = (value) =>
    value === userId || value.toLowerCase() === email;

  if (!identities.every(isOwnIdentity)) {
    return forbidden(res, 'Forbidden: You can only access your own data.');
  }
  return next();
};

const verifyEquipmentOwnership = async (req, res, next) => {
  if (getRole(req) === 'admin') return next();

  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: 'Invalid equipment id.' });
  }

  try {
    const equipment = await database.collection('equipment').findOne({
      _id: new ObjectId(id),
    });
    if (!equipment) {
      return res.status(404).json({ success: false, error: 'Equipment not found.' });
    }

    const userId = getUserId(req) == null ? null : String(getUserId(req));
    const owned =
      (equipment.ownerId != null && userId != null && String(equipment.ownerId) === userId) ||
      (equipment.ownerEmail != null &&
        String(equipment.ownerEmail).toLowerCase() === getUserEmail(req));

    if (!owned) return forbidden(res);
    return next();
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const verifyRentalAccess = async (req, res, next) => {
  if (getRole(req) === 'admin') return next();

  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: 'Invalid rental id.' });
  }

  try {
    const rental = await database.collection('bookings').findOne({
      _id: new ObjectId(id),
    });
    if (!rental) {
      return res.status(404).json({ success: false, error: 'Rental not found.' });
    }

    const userId = getUserId(req) == null ? null : String(getUserId(req));
    const email = getUserEmail(req);
    const isCustomer =
      (rental.customerId != null && userId != null && String(rental.customerId) === userId) ||
      String(rental.customerEmail || '').toLowerCase() === email;
    const isOwner =
      (rental.ownerId != null && userId != null && String(rental.ownerId) === userId) ||
      String(rental.ownerEmail || '').toLowerCase() === email;

    if (!isCustomer && !isOwner) {
      return forbidden(res, 'Forbidden: This rental does not belong to you.');
    }

    req.rental = rental;
    return next();
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const verifyBookingOwnership = async (req, res, next) => {
  if (getRole(req) === 'admin') return next();

  const bookingId = req.body?.bookingId;
  if (!bookingId) {
    return res.status(400).json({ success: false, error: 'bookingId is required.' });
  }
  if (!ObjectId.isValid(bookingId)) {
    return res.status(400).json({ success: false, error: 'Invalid booking id.' });
  }

  try {
    const booking = await database.collection('bookings').findOne({
      _id: new ObjectId(bookingId),
    });
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found.' });
    }

    const userId = getUserId(req) == null ? null : String(getUserId(req));
    const isOwner =
      (booking.customerId != null && userId != null && String(booking.customerId) === userId) ||
      String(booking.customerEmail || '').toLowerCase() === getUserEmail(req);

    if (!isOwner) {
      return forbidden(res, 'Forbidden: This booking does not belong to you.');
    }
    return next();
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const verifyPaymentAccess = async (req, res, next) => {
  if (getRole(req) === 'admin') return next();

  const id = req.params.id;
  const query = ObjectId.isValid(id)
    ? { $or: [{ _id: new ObjectId(id) }, { bookingId: id }, { transactionId: id }] }
    : { $or: [{ bookingId: id }, { transactionId: id }] };

  try {
    const payment = await database.collection('payments').findOne(query);
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment not found.' });
    }
    if (String(payment.customerEmail || '').toLowerCase() !== getUserEmail(req)) {
      return forbidden(res, 'Forbidden: This payment does not belong to you.');
    }
    return next();
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const verifyFavoriteOwnership = async (req, res, next) => {
  if (getRole(req) === 'admin') return next();

  const id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: 'Invalid favorite id.' });
  }

  try {
    const favorite = await database.collection('favorites').findOne({
      _id: new ObjectId(id),
    });
    if (!favorite) {
      return res.status(404).json({ success: false, error: 'Favorite not found.' });
    }

    const userId = getUserId(req) == null ? null : String(getUserId(req));
    const owned =
      (favorite.userId != null && userId != null && String(favorite.userId) === userId) ||
      String(favorite.userEmail || '').toLowerCase() === getUserEmail(req);

    if (!owned) {
      return forbidden(res, 'Forbidden: This favorite does not belong to you.');
    }
    return next();
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

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

app.post('/api/equipment', verifyToken, verifyOwner, async (req, res) => {
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

// Featured equipment: 6 approved equipment items using MongoDB aggregation $limit
app.get('/api/equipment/featured', async (req, res) => {
  try {
    const featured = await database
      .collection('equipment')
      .aggregate([
        { $match: { status: 'Approved' } },
        { $sort: { createdAt: -1 } },
        { $limit: 6 },
      ])
      .toArray();

    return res.status(200).json(featured);
  } catch (err) {
    console.error('Failed to fetch featured equipment:', err);
    return res.status(500).json({ message: 'Failed to fetch featured equipment.' });
  }
});

// Dynamic Rental Categories: Aggregates category counts, available units, sample image, and min rental price
app.get('/api/equipment/categories', async (req, res) => {
  try {
    const aggregated = await database
      .collection('equipment')
      .aggregate([
        { $match: { status: 'Approved' } },
        {
          $group: {
            _id: '$category',
            totalListings: { $sum: 1 },
            availableQuantity: {
              $sum: {
                $cond: [
                  { $gt: ['$availableQuantity', 0] },
                  '$availableQuantity',
                  1,
                ],
              },
            },
            minPrice: { $min: '$rentalPrice' },
            sampleImage: { $first: '$image' },
            sampleDescription: { $first: '$description' },
          },
        },
        { $sort: { totalListings: -1, _id: 1 } },
      ])
      .toArray();

    // Standard fallback categories metadata to enrich dynamically found categories
    const metadataMap = {
      'Construction Equipment': {
        description: 'Excavators, concrete mixers, scaffoldings & compactors',
        gradient: 'from-amber-500/20 to-amber-500/5 text-amber-600 dark:text-amber-400',
        border: 'border-amber-500/20',
      },
      'Photography Equipment': {
        description: 'Cinema cameras, prime lenses, gimbals & studio lighting',
        gradient: 'from-sky-500/20 to-sky-500/5 text-sky-600 dark:text-sky-400',
        border: 'border-sky-500/20',
      },
      'Vehicles & Transportation': {
        description: 'Pickup trucks, cargo vans, trailers & flatbeds',
        gradient: 'from-blue-500/20 to-blue-500/5 text-blue-600 dark:text-blue-400',
        border: 'border-blue-500/20',
      },
      'Agriculture Equipment': {
        description: 'High-horsepower tractors, harvesters & irrigation pumps',
        gradient: 'from-emerald-500/20 to-emerald-500/5 text-emerald-600 dark:text-emerald-400',
        border: 'border-emerald-500/20',
      },
      'Electronics': {
        description: 'Heavy-duty sound systems, drone kits & testing tools',
        gradient: 'from-purple-500/20 to-purple-500/5 text-purple-600 dark:text-purple-400',
        border: 'border-purple-500/20',
      },
      'Event Equipment': {
        description: 'Stage setups, truss systems, industrial generators & lights',
        gradient: 'from-rose-500/20 to-rose-500/5 text-rose-600 dark:text-rose-400',
        border: 'border-rose-500/20',
      },
      'Excavators': {
        description: 'Mini, crawler, and wheeled hydraulic excavators',
        gradient: 'from-orange-500/20 to-orange-500/5 text-orange-600 dark:text-orange-400',
        border: 'border-orange-500/20',
      },
      'Power Tools': {
        description: 'Industrial drills, cutters, grinders, and demolition tools',
        gradient: 'from-teal-500/20 to-teal-500/5 text-teal-600 dark:text-teal-400',
        border: 'border-teal-500/20',
      },
      'Generators': {
        description: 'Silent and open-frame diesel & petrol generators',
        gradient: 'from-yellow-500/20 to-yellow-500/5 text-yellow-600 dark:text-yellow-400',
        border: 'border-yellow-500/20',
      },
    };

    const categories = aggregated
      .filter((c) => c._id && String(c._id).trim() !== '')
      .map((c) => {
        const name = String(c._id).trim();
        const meta = metadataMap[name] || {};
        return {
          title: name,
          name,
          totalListings: c.totalListings || 0,
          availableQuantity: c.availableQuantity || 0,
          minPrice: c.minPrice || 0,
          sampleImage: c.sampleImage || '',
          description: meta.description || c.sampleDescription || 'Professional gear & machinery ready for rental',
          color: meta.gradient || 'from-primary/20 to-primary/5 text-primary',
          border: meta.border || 'border-primary/20',
          count: `${c.totalListings} Listing${c.totalListings === 1 ? '' : 's'} (${c.availableQuantity} Available)`,
        };
      });

    // Ensure we also include popular standard categories if they don't have listings yet
    const standardCategories = [
      'Construction Equipment',
      'Photography Equipment',
      'Vehicles & Transportation',
      'Agriculture Equipment',
      'Electronics',
      'Event Equipment',
    ];

    for (const std of standardCategories) {
      if (!categories.find((c) => c.title.toLowerCase() === std.toLowerCase())) {
        const meta = metadataMap[std] || {};
        categories.push({
          title: std,
          name: std,
          totalListings: 0,
          availableQuantity: 0,
          minPrice: 0,
          sampleImage: '',
          description: meta.description || 'Professional equipment ready for booking',
          color: meta.gradient || 'from-emerald-500/20 to-emerald-500/5 text-emerald-600',
          border: meta.border || 'border-emerald-500/20',
          count: 'Explore Listings',
        });
      }
    }

    return res.status(200).json(categories);
  } catch (err) {
    console.error('Failed to fetch dynamic categories:', err);
    return res.status(500).json({ message: 'Failed to fetch categories.' });
  }
});

// Get all equipment added by a specific owner (by route param)
app.get('/api/equipment/owner/:email', verifyToken, verifyOwner, verifySelf, async (req, res) => {
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
app.get('/api/equipment/owner', verifyToken, verifyOwner, verifySelf, async (req, res) => {
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
app.get('/api/equipment/:id', verifyToken, async (req, res) => {
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
app.put('/api/equipment/:id', verifyToken, verifyOwner, verifyEquipmentOwnership, async (req, res) => {
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
app.patch('/api/equipment/:id/status', verifyToken, verifyAdmin, async (req, res) => {
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
app.delete('/api/equipment/:id', verifyToken, verifyOwner, verifyEquipmentOwnership, async (req, res) => {
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
app.get('/api/rentals/customer/:email', verifyToken, verifyRenter, verifySelf, async (req, res) => {
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
app.get('/api/rentals/customer', verifyToken, verifyRenter, verifySelf, async (req, res) => {
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
app.get('/api/rentals/owner/:email', verifyToken, verifyOwner, verifySelf, async (req, res) => {
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
app.get('/api/rentals/owner', verifyToken, verifyOwner, verifySelf, async (req, res) => {
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

// Get all rentals (Admin platform-wide view with filters and stats)
app.get('/api/rentals', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { search, bookingStatus, paymentStatus } = req.query;
    const query = {};

    if (bookingStatus && bookingStatus !== 'all') {
      query.bookingStatus = bookingStatus;
    }

    if (paymentStatus && paymentStatus !== 'all') {
      query.paymentStatus = paymentStatus;
    }

    if (search && String(search).trim()) {
      const s = String(search).trim();
      const regex = { $regex: s, $options: 'i' };
      query.$or = [
        { customerName: regex },
        { customerEmail: regex },
        { customerPhone: regex },
        { ownerName: regex },
        { ownerEmail: regex },
        { equipmentName: regex },
        { equipmentCategory: regex },
        { deliveryAddress: regex },
        { transactionId: regex },
      ];
    }

    const bookingsCollection = database.collection('bookings');
    const rentals = await bookingsCollection.find(query).sort({ createdAt: -1 }).toArray();

    // Compute platform-wide stats across all bookings
    const allBookings = await bookingsCollection.find({}).toArray();
    let totalRevenue = 0;
    let pendingCount = 0;
    let confirmedCount = 0;
    let inProgressCount = 0;
    let completedCount = 0;
    let cancelledCount = 0;
    let paidCount = 0;
    let unpaidCount = 0;

    for (const b of allBookings) {
      if (b.paymentStatus === 'Paid') {
        totalRevenue += Number(b.totalAmount || b.amount || 0);
        paidCount++;
      } else {
        unpaidCount++;
      }

      const bs = (b.bookingStatus || '').toLowerCase();
      if (bs === 'confirmed') confirmedCount++;
      else if (bs === 'in progress') inProgressCount++;
      else if (bs === 'completed') completedCount++;
      else if (bs === 'cancelled') cancelledCount++;
      else pendingCount++;
    }

    return res.status(200).json({
      rentals,
      stats: {
        totalRentals: allBookings.length,
        totalRevenue,
        pendingCount,
        confirmedCount,
        inProgressCount,
        completedCount,
        cancelledCount,
        paidCount,
        unpaidCount,
      },
    });
  } catch (err) {
    console.error('Failed to fetch all rentals for admin:', err);
    return res.status(500).json({ message: 'Failed to fetch rentals.' });
  }
});

// Get single rental booking by ID (used for checkout / payment page)
app.get('/api/rentals/:id', verifyToken, verifyRentalAccess, async (req, res) => {
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
app.patch('/api/rentals/:id/status', verifyToken, verifyRentalAccess, async (req, res) => {
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

// Update full rental booking details (Admin management)
app.patch('/api/rentals/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid rental booking ID.' });
    }

    const body = req.body || {};
    const updates = {};

    const allowedFields = [
      'customerName',
      'customerEmail',
      'customerPhone',
      'deliveryAddress',
      'additionalNotes',
      'equipmentName',
      'equipmentCategory',
      'ownerName',
      'ownerEmail',
      'startDate',
      'endDate',
      'durationDays',
      'requiredQuantity',
      'rentalPrice',
      'totalAmount',
      'paymentStatus',
      'bookingStatus',
    ];

    allowedFields.forEach((field) => {
      if (body[field] !== undefined) {
        updates[field] = body[field];
      }
    });

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
      message: 'Rental booking updated successfully.',
      rental: result,
    });
  } catch (err) {
    console.error('Failed to update rental booking:', err);
    return res.status(500).json({ message: 'Failed to update rental booking.' });
  }
});

// Delete a rental booking (Admin management)
app.delete('/api/rentals/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid rental booking ID.' });
    }

    const result = await database.collection('bookings').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Rental booking not found.' });
    }

    return res.status(200).json({ message: 'Rental booking deleted successfully.' });
  } catch (err) {
    console.error('Failed to delete rental booking:', err);
    return res.status(500).json({ message: 'Failed to delete rental booking.' });
  }
});

// Create a new rental booking (used by checkout / booking modal)
app.post('/api/rentals', verifyToken, verifyRenter, verifySelf, async (req, res) => {
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
app.post('/api/bookings', verifyToken, verifyRenter, verifySelf, async (req, res) => {
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
app.post('/api/payments', verifyToken, verifyRenter, verifyBookingOwnership, async (req, res) => {
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
app.get('/api/payments/:id', verifyToken, verifyPaymentAccess, async (req, res) => {
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
app.get('/api/users', verifyToken, verifyAdmin, async (req, res) => {
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
app.patch('/api/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
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
app.patch('/api/users/:id', verifyToken, verifyAdmin, async (req, res) => {
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
app.delete('/api/users/:id', verifyToken, verifyAdmin, async (req, res) => {
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
app.get('/api/users/profile/:email', verifyToken, verifySelf, async (req, res) => {
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
app.put('/api/users/profile/:email', verifyToken, verifySelf, async (req, res) => {
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


// Get all favorites for a customer by email (with live equipment data)
app.get('/api/favorites/:email', verifyToken, verifySelf, async (req, res) => {
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

    if (favorites.length === 0) {
      return res.status(200).json([]);
    }

    // Collect equipmentIds and try to build valid ObjectIds
    const equipmentIds = favorites.map((f) => f.equipmentId).filter(Boolean);
    const validObjectIds = [];
    for (const eid of equipmentIds) {
      if (ObjectId.isValid(eid)) {
        validObjectIds.push(new ObjectId(eid));
      }
    }

    // Fetch live equipment data in bulk
    const liveEquipment = await database
      .collection('equipment')
      .find({
        $or: [
          ...(validObjectIds.length > 0 ? [{ _id: { $in: validObjectIds } }] : []),
          { id: { $in: equipmentIds.map(String) } },
        ],
      })
      .toArray();

    // Build a lookup map keyed by equipment id string
    const equipMap = {};
    for (const eq of liveEquipment) {
      const key = (eq._id || eq.id || '').toString();
      equipMap[key] = eq;
      // Also index by string `id` field if present
      if (eq.id && eq.id !== key) {
        equipMap[String(eq.id)] = eq;
      }
    }

    // Merge live data into each favorite
    const enriched = favorites.map((fav) => {
      const live = equipMap[String(fav.equipmentId)] || null;
      if (!live) return fav; // equipment may have been deleted; return as-is

      return {
        ...fav,
        equipmentName: live.equipmentName || live.name || fav.equipmentName,
        category: live.category || fav.category,
        rentalPrice: live.rentalPrice ?? live.price ?? fav.rentalPrice,
        rentalType: live.rentalType || fav.rentalType,
        location: live.location || fav.location,
        availableQuantity: live.availableQuantity ?? live.quantity ?? fav.availableQuantity,
        image: live.image || live.images?.[0] || fav.image,
        brand: live.brand || fav.brand,
        model: live.model || fav.model,
        description: live.description || fav.description,
        ownerName: live.ownerName || fav.ownerName,
        ownerEmail: live.ownerEmail || fav.ownerEmail,
        status: live.status || 'approved',
      };
    });

    return res.status(200).json(enriched);
  } catch (err) {
    console.error('Failed to fetch favorites:', err);
    return res.status(500).json({ message: 'Failed to fetch favorites.' });
  }
});


// Check if specific equipment is in customer's favorites
app.get('/api/favorites/check/:email/:equipmentId', verifyToken, verifySelf, async (req, res) => {
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
app.post('/api/favorites', verifyToken, verifySelf, async (req, res) => {
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
app.delete('/api/favorites/:id', verifyToken, verifyFavoriteOwnership, async (req, res) => {
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
app.delete('/api/favorites/item/:email/:equipmentId', verifyToken, verifySelf, async (req, res) => {
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

/* =========================================================================
   DASHBOARD ANALYTICS ROUTES (ADMIN & OWNER)
   ========================================================================= */

// Helper to generate the last N months structure
function getLastMonths(n = 6) {
  const months = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const shortMonth = d.toLocaleDateString('en-US', { month: 'short' });
    months.push({ key, label, shortMonth, bookings: 0, revenue: 0, earnings: 0, completed: 0 });
  }
  return months;
}

// 1. Admin Analytics (Platform-wide performance)
app.get('/api/analytics/admin', verifyToken, verifyAdmin, async (req, res) => {
  try {
    // 1. Users
    let users = await database
      .collection('user')
      .find({}, { projection: { password: 0 } })
      .toArray();

    if (!users || users.length === 0) {
      users = await database
        .collection('users')
        .find({}, { projection: { password: 0 } })
        .toArray();
    }

    const totalUsers = users.length;
    let customerCount = 0;
    let ownerCount = 0;
    let adminCount = 0;

    users.forEach((u) => {
      const r = (u.role || 'customer').toLowerCase();
      if (r === 'admin') adminCount++;
      else if (r === 'owner') ownerCount++;
      else customerCount++;
    });

    // 2. Equipment
    const allEquipment = await database.collection('equipment').find({}).toArray();
    const totalEquipment = allEquipment.length;
    let pendingApprovals = 0;
    let approvedEquipment = 0;
    let rejectedEquipment = 0;

    allEquipment.forEach((eq) => {
      const s = (eq.status || 'Pending').toLowerCase();
      if (s === 'approved') approvedEquipment++;
      else if (s === 'rejected') rejectedEquipment++;
      else pendingApprovals++;
    });

    // 3. Bookings & Payments
    const allBookings = await database
      .collection('bookings')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const totalBookings = allBookings.length;
    let completedRentals = 0;
    let confirmedRentals = 0;
    let inProgressRentals = 0;
    let pendingRentals = 0;
    let cancelledRentals = 0;
    let totalRevenue = 0;
    let paidBookingsCount = 0;
    let unpaidBookingsCount = 0;

    const monthlyStats = getLastMonths(6);
    const monthMap = new Map(monthlyStats.map((m) => [m.key, m]));

    allBookings.forEach((b) => {
      const bStatus = (b.bookingStatus || '').toLowerCase();
      if (bStatus === 'completed') completedRentals++;
      else if (bStatus === 'confirmed') confirmedRentals++;
      else if (bStatus === 'in progress') inProgressRentals++;
      else if (bStatus === 'cancelled') cancelledRentals++;
      else pendingRentals++;

      const isPaid = (b.paymentStatus || '').toLowerCase() === 'paid';
      const amount = Number(b.totalAmount || b.amount || 0);

      if (isPaid) {
        totalRevenue += amount;
        paidBookingsCount++;
      } else {
        unpaidBookingsCount++;
      }

      // Aggregate into monthly stats
      const d = b.createdAt ? new Date(b.createdAt) : (b.startDate ? new Date(b.startDate) : null);
      if (d && !isNaN(d.getTime())) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const monthEntry = monthMap.get(key);
        if (monthEntry) {
          monthEntry.bookings += 1;
          if (isPaid) {
            monthEntry.revenue += amount;
          }
          if (bStatus === 'completed') {
            monthEntry.completed += 1;
          }
        }
      }
    });

    return res.status(200).json({
      summary: {
        totalUsers,
        totalEquipment,
        totalBookings,
        pendingApprovals,
        completedRentals,
        totalRevenue,
      },
      usersBreakdown: {
        totalUsers,
        customerCount,
        ownerCount,
        adminCount,
      },
      equipmentBreakdown: {
        totalEquipment,
        approvedEquipment,
        pendingApprovals,
        rejectedEquipment,
      },
      bookingsBreakdown: {
        totalBookings,
        completedRentals,
        confirmedRentals,
        inProgressRentals,
        pendingRentals,
        cancelledRentals,
        paidBookingsCount,
        unpaidBookingsCount,
      },
      monthlyBookingStats: monthlyStats,
      recentBookings: allBookings.slice(0, 5),
    });
  } catch (err) {
    console.error('Failed to compute admin analytics:', err);
    return res.status(500).json({ message: 'Failed to compute admin analytics.' });
  }
});

// 2. Owner Analytics (Individual Rental Business Performance)
app.get('/api/analytics/owner', verifyToken, verifyOwner, verifySelf, async (req, res) => {
  try {
    const email = req.query.email ? String(req.query.email).trim() : null;
    const ownerId = req.query.ownerId ? String(req.query.ownerId).trim() : null;

    if (!email && !ownerId) {
      return res.status(400).json({ message: 'Owner email or ownerId query parameter is required.' });
    }

    // 1. Owner's Equipment
    const equipConditions = [];
    if (email) {
      equipConditions.push(
        { ownerEmail: email },
        { ownerEmail: email.toLowerCase() },
        { userEmail: email },
        { userEmail: email.toLowerCase() }
      );
    }
    if (ownerId) {
      equipConditions.push({ ownerId: ownerId }, { userId: ownerId });
    }

    const equipQuery = equipConditions.length > 0 ? { $or: equipConditions } : {};
    const ownerEquipment = await database.collection('equipment').find(equipQuery).toArray();

    const totalListedEquipment = ownerEquipment.length;
    let approvedEquipment = 0;
    let pendingApprovals = 0;
    let rejectedEquipment = 0;
    const ownerEquipmentIds = new Set();

    ownerEquipment.forEach((eq) => {
      const idStr = eq._id ? eq._id.toString() : '';
      if (idStr) ownerEquipmentIds.add(idStr);

      const s = (eq.status || 'Pending').toLowerCase();
      if (s === 'approved') approvedEquipment++;
      else if (s === 'rejected') rejectedEquipment++;
      else pendingApprovals++;
    });

    // 2. Owner's Bookings
    const bookingConditions = [];
    if (email) {
      bookingConditions.push(
        { ownerEmail: email },
        { ownerEmail: email.toLowerCase() }
      );
    }
    if (ownerId) {
      bookingConditions.push({ ownerId: ownerId });
    }
    if (ownerEquipmentIds.size > 0) {
      bookingConditions.push({ equipmentId: { $in: Array.from(ownerEquipmentIds) } });
    }

    const bookingQuery = bookingConditions.length > 0 ? { $or: bookingConditions } : {};
    const ownerBookings = await database
      .collection('bookings')
      .find(bookingQuery)
      .sort({ createdAt: -1 })
      .toArray();

    const totalBookings = ownerBookings.length;
    let completedRentals = 0;
    let activeRentals = 0; // Confirmed or In Progress
    let pendingRentals = 0;
    let cancelledRentals = 0;
    let totalEarnings = 0;
    let pendingEarnings = 0;

    const monthlyStats = getLastMonths(6);
    const monthMap = new Map(monthlyStats.map((m) => [m.key, m]));

    // Map equipment earnings performance
    const equipPerformanceMap = new Map();
    ownerEquipment.forEach((eq) => {
      const id = eq._id.toString();
      equipPerformanceMap.set(id, {
        equipmentId: id,
        equipmentName: eq.equipmentName,
        category: eq.category,
        image: eq.image,
        rentalPrice: eq.rentalPrice,
        rentalType: eq.rentalType,
        totalBookings: 0,
        totalEarnings: 0,
      });
    });

    ownerBookings.forEach((b) => {
      const bStatus = (b.bookingStatus || '').toLowerCase();
      if (bStatus === 'completed') completedRentals++;
      else if (bStatus === 'confirmed' || bStatus === 'in progress') activeRentals++;
      else if (bStatus === 'cancelled') cancelledRentals++;
      else pendingRentals++;

      const isPaid = (b.paymentStatus || '').toLowerCase() === 'paid';
      const amount = Number(b.totalAmount || b.amount || 0);

      if (isPaid) {
        totalEarnings += amount;
      } else {
        pendingEarnings += amount;
      }

      // Track equipment stats
      if (b.equipmentId && equipPerformanceMap.has(String(b.equipmentId))) {
        const item = equipPerformanceMap.get(String(b.equipmentId));
        item.totalBookings += 1;
        if (isPaid) {
          item.totalEarnings += amount;
        }
      }

      // Aggregate into monthly stats
      const d = b.createdAt ? new Date(b.createdAt) : (b.startDate ? new Date(b.startDate) : null);
      if (d && !isNaN(d.getTime())) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const monthEntry = monthMap.get(key);
        if (monthEntry) {
          monthEntry.bookings += 1;
          if (isPaid) {
            monthEntry.earnings += amount;
            monthEntry.revenue += amount;
          }
          if (bStatus === 'completed') {
            monthEntry.completed += 1;
          }
        }
      }
    });

    const equipmentPerformance = Array.from(equipPerformanceMap.values())
      .sort((a, b) => b.totalEarnings - a.totalEarnings);

    return res.status(200).json({
      summary: {
        totalListedEquipment,
        completedRentals,
        totalEarnings,
        activeRentals,
        totalBookings,
        pendingEarnings,
      },
      equipmentBreakdown: {
        totalListedEquipment,
        approvedEquipment,
        pendingApprovals,
        rejectedEquipment,
      },
      bookingsBreakdown: {
        totalBookings,
        completedRentals,
        activeRentals,
        pendingRentals,
        cancelledRentals,
      },
      monthlyEarnings: monthlyStats,
      equipmentPerformance,
      recentRentals: ownerBookings.slice(0, 5),
    });
  } catch (err) {
    console.error('Failed to compute owner analytics:', err);
    return res.status(500).json({ message: 'Failed to compute owner analytics.' });
  }
});


app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
