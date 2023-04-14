import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
  firehearts: {
    type: Number,
    required: true,
    default: 600,
  },
  image: {
    type: Object,
    required: true,
  },
  lastEdited: {
    type: Date,
    required: true,
    default: Date.now(),
  },
  yearOfStudy: {
    type: Number,
    required: true,
  },
  id: {
    type: String,
    required: true,
  },
});

export default mongoose.model("User", userSchema);
