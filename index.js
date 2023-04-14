import express from "express";
import multer from "multer";
import path from "path";
import { v4 } from "uuid";
import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "./models/user.js";
import RefreshToken from "./models/refreshToken.js";
import bodyParser from "body-parser";
import sharp from "sharp";
import * as fs from "fs";
import { encode } from "blurhash";
import jwt from "jsonwebtoken";
import cors from "cors";
dotenv.config();

const PORT = 3001;

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN,
  })
);

// mongodb
mongoose.connect(process.env.MONGODB_URL);
const db = mongoose.connection;
db.on("error", (err) => console.log(err));
db.once("open", () => console.log("Connected to Database"));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// verify and authenticate token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["x-auth-token-header"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) {
    return res.status(401).json({
      message: "Unauthorized",
    });
  }
  jwt.verify(
    token,
    process.env.JWT_ACCESS_TOKEN_SECRET,
    (err, loginDetails) => {
      if (err) {
        console.log(err);
        return res.status(403).json({
          message: "Token Invalid",
        });
      }
      req.loginDetails = loginDetails;
      next();
    }
  );
};

// Image Upload and send facility from server ----------------
const storage = multer.diskStorage({
  destination: "./user_images",
  filename: (req, file, cb) => {
    return cb(null, `${v4()}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 3000000, // 3 MB
  },
});

function imageErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    return res.status(403).json({
      message: err.message,
    });
  }
}

const compress = async (req, res, next) => {
  console.log(1, req.file);
  try {
    const fileBuffer = fs.readFileSync(`./user_images/${req.file.filename}`);
    const compressedBuffer = await sharp(fileBuffer)
      .resize({ width: 600 })
      .jpeg({ quality: 80 }) // Set JPEG quality to 80 (adjust as needed)
      .toBuffer();
    fs.writeFileSync(`./user_images/${req.file.filename}`, compressedBuffer);
    next();
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      message: "Unable to compress image",
    });
  }
};

const encodeImageToBlurhash = (path) =>
  new Promise((resolve, reject) => {
    sharp(path)
      .raw()
      .ensureAlpha()
      .resize(32, 32, { fit: "inside" })
      .toBuffer((err, buffer, { width, height }) => {
        if (err) return reject(err);
        resolve(encode(new Uint8ClampedArray(buffer), width, height, 4, 4));
      });
  });

const blurhash = async (req, res, next) => {
  try {
    encodeImageToBlurhash(`./user_images/${req.file.filename}`).then((hash) => {
      req.blurhash = hash;
      next();
    });
  } catch (err) {
    return res.status(500).json({
      message: "Unable to generate blurhash",
    });
  }
};

app.use("/profile/image", express.static("./user_images"));
app.use(imageErrorHandler);

// ------------------------------------------------------------

// get user from firebase_auth_id: (id)
app.get("/user/:id", authenticateToken, async (req, res) => {
  try {
    const user = await User.findOne({
      id: req.params.id,
    });
    if (user == null) {
      return res.status(404).json("Cannot find the user");
    }
    const rank =
      (await User.countDocuments({ firehearts: { $gt: user.firehearts } })) + 1;
    res.status(200).json({
      ...user._doc,
      rank: rank,
    });
  } catch (err) {
    return res.status(500).json({
      message: err.message,
    });
  }
});

// get random users
app.get("/random", authenticateToken, async (req, res) => {
  try {
    const users = await User.aggregate([
      {
        $sample: {
          size: req.body.count ?? 5,
        },
      },
    ]);
    res.status(200).json(users);
  } catch (err) {
    return res.status(500).json({
      message: err.message,
    });
  }
});

// get leaderboard users
app.get("/leaderboard", async (req, res) => {
  try {
    const users = await User.find()
      .sort({ firehearts: -1, lastEdited: 1 })
      .limit(req.body.count ?? 10);
    res.status(200).json(users.map((user) => user._doc));
  } catch (err) {
    return res.status(500).json({
      message: err.message,
    });
  }
});

// upload image and return the url
// request must be of type form-data
app.post(
  "/upload",
  [upload.single("image"), compress, blurhash],
  async (req, res) => {
    try {
      res.status(201).json({
        url: `http://localhost:${PORT}/profile/image/${req.file.filename}`,
        blurhash: req.blurhash,
      });
    } catch (err) {
      return res.status(500).json({
        message: "Image upload failed",
      });
    }
  }
);

// create a new user
app.post("/profile", async (req, res) => {
  const user = new User({
    id: req.body.id,
    name: req.body.name,
    email: req.body.email,
    image: req.body.image,
    yearOfStudy: req.body.yearOfStudy,
  });
  try {
    const newUser = await user.save();
    const loginDetails = {
      name: newUser.name,
      email: newUser.email,
      id: newUser.id,
      _id: newUser._id,
    };
    const accessToken = jwt.sign(
      loginDetails,
      process.env.JWT_ACCESS_TOKEN_SECRET,
      {
        expiresIn: "15m",
      }
    );
    const refreshToken = jwt.sign(
      loginDetails,
      process.env.JWT_REFRESH_TOKEN_SECRET
    );
    const refreshTokenObject = new RefreshToken({
      token: refreshToken,
      userId: newUser.id,
    });
    await refreshTokenObject.save();
    res.status(201).json({
      accessToken: accessToken,
      refreshToken: refreshToken,
    });
  } catch (err) {
    return res.status(400).json({
      message: err.message,
    });
  }
});

const deleteOldImage = (imageURL) => {
  const urlParts = imageURL.split("/");
  const imageName = urlParts[urlParts.length - 1];
  fs.unlinkSync(`./user_images/${imageName}`);
};

//update user
app.patch("/update", authenticateToken, async (req, res) => {
  try {
    const user = await User.findOne({
      id: req.loginDetails.id,
    });
    if (user == null) {
      return res.status(404).json("Cannot find the user");
    }
    const oldImage = user.image;
    if (req.body.name != null) {
      user.name = req.body.name;
    }
    if (req.body.image != null) {
      user.image = req.body.image;
    }
    if (req.body.yearOfStudy != null) {
      user.yearOfStudy = req.body.yearOfStudy;
    }
    user.lastEdited = Date.now();
    const updatedUser = await user.save();
    if (req.body.image != null) {
      deleteOldImage(oldImage.url);
    }
    res.status(201).json(updatedUser);
  } catch (err) {
    console.log(err);
    return res.status(400).json({
      message: err.message,
    });
  }
});

// increment the value of firehearts
app.patch("/increment", authenticateToken, async (req, res) => {
  try {
    const user = await User.findOne({
      id: req.body.id,
    });
    if (user == null) {
      return res.status(404).json("Cannot find the user");
    }
    if (req.body.increment != null) {
      user.firehearts += Math.max(-20, Math.min(20, req.body.increment));
    }
    user.lastEdited = Date.now();
    const updatedUser = await user.save();
    res.status(201).json(updatedUser);
  } catch (err) {
    return res.status(400).json({
      message: err.message,
    });
  }
});

// generate new token route
app.post("/token", async (req, res) => {
  const refreshToken = req.body.token;
  if (refreshToken == null) {
    return res.status(401).json({
      message: "Unauthorized",
    });
  }
  const refreshTokenObject = await RefreshToken.findOne({
    token: refreshToken,
  });
  if (refreshTokenObject == null) {
    return res.status(403).json({
      message: "Invalid Token",
    });
  }
  jwt.verify(
    refreshToken,
    process.env.JWT_REFRESH_TOKEN_SECRET,
    (err, loginDetails) => {
      if (err) {
        return res.status(403).json({
          message: "Invalid Token",
        });
      }
      const accessToken = jwt.sign(
        loginDetails,
        process.env.JWT_ACCESS_TOKEN_SECRET,
        {
          expiresIn: "1w",
        }
      );
      res.status(201).json({
        accessToken: accessToken,
        refreshToken: refreshToken,
      });
    }
  );
});

// login a user (generate token and send)
app.post("/login", async (req, res) => {
  const id = req.body.id;

  try {
    const user = await User.findOne({ id: id });
    if (user == null) {
      return res.status(404).json({
        message: "User not found",
      });
    }
    const loginDetails = {
      name: user.name,
      email: user.email,
      id: user.id,
      _id: user._id,
    };
    const accessToken = jwt.sign(
      loginDetails,
      process.env.JWT_ACCESS_TOKEN_SECRET,
      {
        expiresIn: "1w",
      }
    );
    const refreshToken = jwt.sign(
      loginDetails,
      process.env.JWT_REFRESH_TOKEN_SECRET
    );
    const refreshTokenObject = new RefreshToken({
      token: refreshToken,
      userId: user.id,
    });
    await refreshTokenObject.save();
    res.status(201).json({
      accessToken: accessToken,
      refreshToken: refreshToken,
    });
  } catch (err) {
    return res.status(400).json({
      message: err.message,
    });
  }
});

app.delete("/logout", authenticateToken, async (req, res) => {
  await RefreshToken.deleteMany({
    userId: req.loginDetails.id,
  });
  res.status(200).json({
    message: "Logged out successfully",
  });
});

app.listen(PORT, () => {
  console.log("Server running on port ", PORT);
});
