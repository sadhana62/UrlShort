const jwt = require('jsonwebtoken');
function authMiddleware(req,res) {
    const authHeader = req.headers[`authorization`];
    const token = authHeader && authHeader.split(' ')[1];// Bearer token 

     if (!token) {
       return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // attaches { userId, email } to the request
        next();
     } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

}

module.exports = authMiddleware;