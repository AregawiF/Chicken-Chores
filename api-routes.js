const express = require('express');
const router = express.Router();

// Initialize Stripe and Firebase Admin
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Initialize Firebase Admin (only if not already initialized)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    })
  });
}

const db = admin.firestore();

// Middleware for parsing JSON (for most API routes)
router.use((req, res, next) => {
  // Skip JSON parsing for webhook route (needs raw body)
  if (req.path === '/webhook') {
    return next();
  }
  express.json()(req, res, next);
});

// *** STRIPE API ROUTES ***

// 1. CREATE CHECKOUT SESSION
router.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, userId, email, familyName, isNewSignup } = req.body;

    // Define your pricing (replace these with actual Price IDs from Stripe Dashboard)
    const prices = {
      monthly: process.env.STRIPE_MONTHLY_PRICE_ID || 'price_YOUR_MONTHLY_PRICE_ID',
      yearly: process.env.STRIPE_YEARLY_PRICE_ID || 'price_YOUR_YEARLY_PRICE_ID'
    };

    console.log('Creating checkout session for:', { plan, userId, email, isNewSignup });

    // Create Stripe checkout session
    const sessionConfig = {
      payment_method_types: ['card'],
      line_items: [
        {
          price: prices[plan],
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${req.headers.origin}?success=true${isNewSignup ? '&signup=true' : ''}`,
      cancel_url: `${req.headers.origin}?canceled=true`,
      customer_email: email,
      metadata: {
        userId: userId || 'pending',
        familyName: familyName,
        plan: plan,
        isNewSignup: isNewSignup ? 'true' : 'false'
      }
    };

    const session = await stripe.checkout.sessions.create(sessionConfig);

    res.json({ id: session.id });

  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session', details: error.message });
  }
});

// 4. VERIFY PAYMENT (Security endpoint)
router.post('/verify-payment', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log('🔒 Verifying payment for email:', email);

    // Find customer by email
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (customers.data.length === 0) {
      console.log('❌ No customer found for email:', email);
      return res.json({ hasValidPayment: false });
    }

    const customer = customers.data[0];

    // Get active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      console.log('❌ No active subscriptions found for customer:', customer.id);
      return res.json({ hasValidPayment: false });
    }

    const subscription = subscriptions.data[0];
    
    // Check if subscription is actually active and not expired
    const now = Math.floor(Date.now() / 1000);
    if (subscription.current_period_end < now) {
      console.log('❌ Subscription has expired for customer:', customer.id);
      return res.json({ hasValidPayment: false });
    }

    console.log('✅ Valid payment found for email:', email);
    res.json({ hasValidPayment: true });

  } catch (error) {
    console.error('❌ Error verifying payment:', error);
    res.status(500).json({ error: 'Failed to verify payment', details: error.message });
  }
});

// 2. RESTORE SUBSCRIPTION
router.post('/restore-subscription', async (req, res) => {
  try {
    const { userId, email } = req.body;

    console.log('Checking for existing subscription for:', email);

    // Find customer by email
    const customers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (customers.data.length === 0) {
      console.log('No customer found for email:', email);
      return res.json({ subscription: null });
    }

    const customer = customers.data[0];

    // Get active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1
    });

    if (subscriptions.data.length === 0) {
      console.log('No active subscriptions found for customer:', customer.id);
      return res.json({ subscription: null });
    }

    const subscription = subscriptions.data[0];
    const plan = subscription.items.data[0].price.recurring.interval; // 'month' or 'year'

    // Calculate correct period end
    let periodEnd = null;
    if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
      const ends = subscription.items.data
        .map(item => item.current_period_end)
        .filter(Boolean);
      if (ends.length > 0) {
        periodEnd = Math.min(...ends);
      }
    }
    const subscriptionEndDate = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

    console.log('Found active subscription:', subscription.id, 'Plan:', plan);

    res.json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        customer: customer.id,
        plan: plan === 'year' ? 'yearly' : 'monthly',
        current_period_end: subscriptionEndDate
      }
    });

  } catch (error) {
    console.error('Error checking subscription:', error);
    res.status(500).json({ error: 'Failed to check subscription', details: error.message });
  }
});

// 3. STRIPE WEBHOOK (Raw body parsing for signature verification)
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, 
      sig, 
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('🔔 Received webhook event:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('💳 Payment completed for session:', session.id);
        
        if (session.subscription && session.metadata && session.metadata.userId !== 'pending') {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
        
          // Existing user - update their subscription in Firebase
          await updateUserSubscription(session.metadata.userId, {
            status: 'active',
            plan: session.metadata.plan,
            customerId: session.customer,
            subscriptionId: session.subscription,
            subscriptionEndDate: (() => {
              let periodEnd = null;
              if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
                const ends = subscription.items.data
                  .map(item => item.current_period_end)
                  .filter(Boolean);
                if (ends.length > 0) {
                  periodEnd = Math.min(...ends);
                }
              }
              return periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
            })()
          });
          
          console.log('✅ Subscription activated for existing user:', session.metadata.userId);
          
        } else {
          console.log('🆕 New user signup detected - subscription will be updated once account is created');
        }
        break;

      case 'invoice.payment_succeeded':
        // Handle successful recurring payment
        const invoice = event.data.object;
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          
          // Find user by customer ID and update subscription
          const customer = await stripe.customers.retrieve(subscription.customer);
          console.log('💰 Recurring payment succeeded for:', customer.email);
          
          // Note: We'd need to find userId by customer email in a real app
          // For now, this just logs the successful payment
        }
        break;

      case 'customer.subscription.updated':
        // Handle subscription status changes (e.g., past_due, active, canceled)
        const updatedSub = event.data.object;
        console.log('🔄 Subscription updated:', updatedSub.id, 'Status:', updatedSub.status);
        
        if (updatedSub.metadata && updatedSub.metadata.userId && updatedSub.metadata.userId !== 'pending') {
          const statusMap = {
            'active': 'active',
            'past_due': 'expired', 
            'canceled': 'cancelled',
            'unpaid': 'expired'
          };
          
          await updateUserSubscription(updatedSub.metadata.userId, {
            status: statusMap[updatedSub.status] || 'expired',
            subscriptionEndDate: (() => {
              let periodEnd = null;
              if (updatedSub.items && updatedSub.items.data && updatedSub.items.data.length > 0) {
                const ends = updatedSub.items.data
                  .map(item => item.current_period_end)
                  .filter(Boolean);
                if (ends.length > 0) {
                  periodEnd = Math.min(...ends);
                }
              }
              return periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
            })()
          });
          
          console.log('✅ Updated user subscription status to:', statusMap[updatedSub.status] || 'expired');
        }
        break;

      case 'customer.subscription.deleted':
        // Handle subscription cancellation
        const canceledSub = event.data.object;
        if (canceledSub.metadata && canceledSub.metadata.userId) {
          await updateUserSubscription(canceledSub.metadata.userId, {
            status: 'cancelled',
            subscriptionEndDate: null
          });
        }
        console.log('❌ Subscription cancelled:', canceledSub.id);
        break;

      case 'invoice.payment_failed':
        // Handle failed payment - mark subscription as at risk
        const failedInvoice = event.data.object;
        if (failedInvoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(failedInvoice.subscription);
          console.log('⚠️ Payment failed for subscription:', failedInvoice.subscription);
          
          if (subscription.metadata && subscription.metadata.userId) {
            // Mark subscription as expired after payment failure
            await updateUserSubscription(subscription.metadata.userId, {
              status: 'expired',
              subscriptionEndDate: (() => {
                let periodEnd = null;
                if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
                  const ends = subscription.items.data
                    .map(item => item.current_period_end)
                    .filter(Boolean);
                  if (ends.length > 0) {
                    periodEnd = Math.min(...ends);
                  }
                }
                return periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
              })()
            });
            
            console.log('💳 Marked subscription as expired due to payment failure');
          }
        }
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });

  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// 4. CANCEL SUBSCRIPTION
router.post('/cancel-subscription', async (req, res) => {
  try {
    const { userId, subscriptionId } = req.body;
    if (!userId || !subscriptionId) {
      return res.status(400).json({ error: 'Missing userId or subscriptionId' });
    }

    // Cancel the Stripe subscription immediately
    const canceled = await stripe.subscriptions.cancel(subscriptionId);

    // Update Firestore (will also be updated by webhook, but do it here for instant feedback)
    await updateUserSubscription(userId, {
      status: 'cancelled',
      subscriptionEndDate: null
    });

    res.json({ success: true, canceled });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription', details: error.message });
  }
});

// Helper function to update user subscription in Firebase
async function updateUserSubscription(userId, subscriptionData) {
  if (!userId) {
    console.error('❌ No userId provided for subscription update');
    return;
  }

  try {
    const userRef = db.collection('families').doc(userId);
    await userRef.update({
      subscriptionData: subscriptionData
    }, { merge: true });
    
    console.log('✅ Updated subscription in Firebase for user:', userId);
    console.log('📊 Subscription data:', subscriptionData);
  } catch (error) {
    console.error('❌ Error updating user subscription in Firebase:', error);
  }
}

// Export router and helper functions
module.exports = { 
  router, 
  updateUserSubscription 
}; 