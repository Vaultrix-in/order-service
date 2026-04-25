require('dotenv').config();
const connectDB = require('./config/db');
const express = require('express');
const cors = require('cors');
const Order = require('./models/Order');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3002;
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://127.0.0.1:3007';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://127.0.0.1:3001';
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'vaultrix-internal-token';

connectDB();

const ok = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const err = (res, message, status = 400) => res.status(status).json({ success: false, message });

const hydrateOrderUserDetails = async (orderDoc) => {
    const order = orderDoc.toObject ? orderDoc.toObject() : { ...orderDoc };

    if (order.userEmail && order.userName) return order;
    if (!order.userId || order.userId === 'admin' || typeof fetch !== 'function') return order;

    try {
        const response = await fetch(`${USER_SERVICE_URL}/users/internal/${order.userId}`, {
            headers: { 'x-internal-token': INTERNAL_SERVICE_TOKEN },
        });
        if (!response.ok) return order;

        const payload = await response.json();
        const user = payload.user;
        if (!user) return order;

        order.userEmail = order.userEmail || user.email;
        order.userName = order.userName || user.name;

        if (orderDoc.userEmail !== order.userEmail || orderDoc.userName !== order.userName) {
            orderDoc.userEmail = order.userEmail;
            orderDoc.userName = order.userName;
            await orderDoc.save();
        }

        return order;
    } catch (error) {
        console.error('[order-service] failed to hydrate order user details:', error.message);
        return order;
    }
};

const sendOrderNotification = async (eventType, orderDoc) => {
    if (typeof fetch !== 'function') {
        return {
            success: false,
            message: 'Notification skipped because fetch is not available in this Node runtime.',
        };
    }

    const order = await hydrateOrderUserDetails(orderDoc);

    try {
        const response = await fetch(`${NOTIFICATION_SERVICE_URL}/notifications/order-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventType, order }),
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            return {
                success: false,
                message: payload.message || `Notification service returned ${response.status}`,
            };
        }

        return {
            success: true,
            message: payload.message || 'Email sent successfully.',
        };
    } catch (error) {
        return {
            success: false,
            message: error.message || 'Notification request failed.',
        };
    }
};

app.post('/orders', async (req, res) => {
    try {
        const {
            userId, userName, userEmail,
            serviceId, serviceName, description, address, scheduledDate, amount,
            isCustomService, serviceVisibility, serviceOwnerUserId,
        } = req.body;

        if (!userId || !userName || !userEmail || !serviceId || !serviceName || !description || !address || !scheduledDate || !amount)
            return err(res, 'userId, userName, userEmail, serviceId, serviceName, description, address, scheduledDate, and amount are required');

        const order = await Order.create({
            userId,
            userName,
            userEmail: userEmail.toLowerCase(),
            serviceId,
            serviceName,
            isCustomService: Boolean(isCustomService),
            serviceVisibility: serviceVisibility === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC',
            serviceOwnerUserId: serviceVisibility === 'PRIVATE' || isCustomService ? (serviceOwnerUserId || userId) : undefined,
            description,
            address,
            scheduledDate: new Date(scheduledDate),
            amount: Number(amount),
        });

        ok(res, { order }, 201);
    } catch (e) {
        err(res, e.message, 500);
    }
});

app.get('/orders', async (req, res) => {
    try {
        const filter = {};
        if (req.query.userId) filter.userId = req.query.userId;
        if (req.query.status) filter.status = req.query.status;
        const orders = await Order.find(filter).sort({ createdAt: -1 });
        ok(res, { orders });
    } catch (e) {
        err(res, e.message, 500);
    }
});

app.get('/orders/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return err(res, 'Order not found', 404);
        ok(res, { order });
    } catch (e) {
        err(res, e.message, 400);
    }
});

app.patch('/orders/:id/approve', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return err(res, 'Order not found', 404);
        if (order.status !== 'PENDING') return err(res, `Cannot approve an order with status ${order.status}`);

        order.status = 'APPROVED';
        await order.save();

        const notification = await sendOrderNotification('APPROVED', order);
        ok(res, {
            order,
            notification,
            message: notification.success
                ? 'Order approved and email sent.'
                : `Order approved, but email could not be sent: ${notification.message}`,
        });
    } catch (e) {
        err(res, e.message, 500);
    }
});

app.patch('/orders/:id/reject', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return err(res, 'Order not found', 404);
        if (order.status !== 'PENDING') return err(res, `Cannot reject an order with status ${order.status}`);

        const reason = req.body.reason?.trim();
        if (!reason) return err(res, 'A rejection reason is required.');

        order.status = 'REJECTED';
        order.rejectionReason = reason;
        await order.save();

        const notification = await sendOrderNotification('REJECTED', order);
        ok(res, {
            order,
            notification,
            message: notification.success
                ? 'Order rejected and apology email sent.'
                : `Order rejected, but email could not be sent: ${notification.message}`,
        });
    } catch (e) {
        err(res, e.message, 500);
    }
});

app.patch('/orders/:id/pay', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return err(res, 'Order not found', 404);
        if (order.status !== 'APPROVED') return err(res, 'Order must be APPROVED before payment');
        if (order.paymentStatus === 'PAID') return err(res, 'Order already paid');
        order.paymentStatus = 'PAID';
        await order.save();
        ok(res, { order });
    } catch (e) {
        err(res, e.message, 500);
    }
});

app.patch('/orders/:id/complete', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return err(res, 'Order not found', 404);
        if (order.status !== 'APPROVED') return err(res, 'Order must be APPROVED to complete');
        if (order.paymentStatus !== 'PAID') return err(res, 'Order must be PAID before marking complete');

        order.status = 'COMPLETED';
        await order.save();

        const notification = await sendOrderNotification('COMPLETED', order);
        ok(res, {
            order,
            notification,
            message: notification.success
                ? 'Order marked complete and follow-up email sent.'
                : `Order marked complete, but email could not be sent: ${notification.message}`,
        });
    } catch (e) {
        err(res, e.message, 500);
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'order-service' }));
app.listen(PORT, '0.0.0.0', () => console.log(`[order-service] running on port ${PORT}`));
