const express = require('express');
const authRoutes = require('./routes/auth');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

app.listen(3000, () => console.log('Server running on port 3000'));