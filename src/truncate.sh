BEGIN;

TRUNCATE TABLE
  auth_otps,
  cart_items,
  feedback_tickets,
  india_post_bookings,
  orders,
  payment_gateway_logs,
  payment_sessions,
  shipment_bonus_items,
  shipment_items,
  shipments,
  submissions,
  upload_logs,
  users
RESTART IDENTITY CASCADE;

COMMIT;