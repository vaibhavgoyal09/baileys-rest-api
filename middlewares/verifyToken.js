require('dotenv').config();

const { ACCESS_TOKEN_SECRET } = process.env;

const verifyToken = async (req, res, next) => {
  if (!req.headers['x-access-token']) {
    res.sendError(401, 'Unauthorized access: No token provided');
    return;
  }

  if (req.headers['x-access-token'] !== ACCESS_TOKEN_SECRET) {
    res.sendError(401, 'Unauthorized access: Invalid token');
    return;
  }

  next();
};

module.exports = verifyToken;
