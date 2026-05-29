require('dotenv').config();

/**
 * Sends a WhatsApp message using the external API.
 * @param {string} message - The message text to send.
 * @param {string} [number] - Optional phone number or group JID. Defaults to WHATSAPP_NOTIFICATION_NUMBER from .env.
 * @returns {Promise<Object>} - The API response.
 */
async function sendWhatsAppNotification(message, number = null) {
  try {
    const targetNumber = number || process.env.WHATSAPP_NOTIFICATION_NUMBER;
    
    if (!targetNumber) {
      console.error('WhatsApp Notification Error: No target number specified and WHATSAPP_NOTIFICATION_NUMBER is not set in .env');
      return { success: false, error: 'No target number specified' };
    }

    const payload = {
      number: targetNumber,
      message: message
    };

    const response = await fetch('https://deswa.io7.my/api/external/send-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('WhatsApp Notification API Error:', data);
      return { 
        success: false, 
        error: data.error || `HTTP error ${response.status}`,
        details: data.details || null
      };
    }

    return data;
  } catch (error) {
    console.error('WhatsApp Notification Error:', error.message);
    return { 
      success: false, 
      error: error.message
    };
  }
}

module.exports = {
  sendWhatsAppNotification
};
