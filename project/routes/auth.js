const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('../db');
const router = express.Router();




router.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, password_hash]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login',async (req,res) =>{
    const {email,password} =req.body;
    try {

        const result = await pool.query(' SELECT * FROM USERS WHERE email = $1',[email]);
        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
          return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign(
        { userId: user.id, email: user.email },
         process.env.JWT_SECRET,
        { expiresIn: '7d' }
        );

        res.json({ token });

    }catch(err){
       res.status(500).json({ error: err.message });
    }

});

module.exports = router;