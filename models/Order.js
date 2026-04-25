const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    userId:        { type: String, required: true },
    userName:      { type: String, trim: true },
    userEmail:     { type: String, lowercase: true, trim: true },
    serviceId:     { type: String, required: true },
    serviceName:   { type: String, required: true },
    isCustomService: { type: Boolean, default: false },
    serviceVisibility: {
        type: String,
        enum: ['PUBLIC', 'PRIVATE'],
        default: 'PUBLIC'
    },
    serviceOwnerUserId: { type: String, trim: true },
    description:   { type: String, required: true },
    address:       { type: String, required: true },
    scheduledDate: { type: Date,   required: true },
    amount:        { type: Number, required: true },
    status: {
        type: String,
        enum: ['PENDING', 'APPROVED', 'REJECTED', 'COMPLETED'],
        default: 'PENDING'
    },
    paymentStatus: {
        type: String,
        enum: ['UNPAID', 'PAID'],
        default: 'UNPAID'
    },
    rejectionReason: { type: String, trim: true },
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
