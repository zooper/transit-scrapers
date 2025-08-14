const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for Home Assistant
app.use(cors());
app.use(express.json());

class LightRailScraper {
  constructor() {
    this.browser = null;
    this.lastData = {
      northbound: [],
      southbound: [],
      lastUpdated: null,
      status: 'initializing'
    };
    this.isRunning = false;
    this.scrapeInterval = null;
    this.scrapeIntervalMinutes = 3; // Scrape every 3 minutes
  }

  log(message, data = null) {
    console.log(message, data || '');
  }

  async init() {
    try {
      console.log('Initializing headless browser...');
      this.browser = await puppeteer.launch({
        headless: "new",
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      });
      console.log('Browser initialized successfully');
    } catch (error) {
      console.error('Failed to initialize browser:', error);
      throw error;
    }
  }

  async scrapeData() {
    if (this.isRunning) {
      console.log('Scraping already in progress, skipping...');
      return this.lastData;
    }

    // Clear previous log (if log file is configured)
    if (this.logFile) {
      fs.writeFileSync(this.logFile, '');
    }
    
    this.isRunning = true;
    console.log('Starting scrape operation...');
    this.log('=== NEW SCRAPE SESSION STARTED ===');

    try {
      const page = await this.browser.newPage();
      
      // Set user agent to avoid detection
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      let graphqlData = null;
      
      // Intercept both requests and responses to understand the GraphQL query structure
      page.on('request', async request => {
        if (request.url().includes('graphql') && request.method() === 'POST') {
          const postData = request.postData();
          console.log('GraphQL Request:', request.url());
          console.log('GraphQL Query:', postData);
        }
      });
      
      page.on('response', async response => {
        try {
          const url = response.url();
          
          // Check for GraphQL or API calls that might contain departure data
          if (url.includes('graphql') && response.request().method() === 'POST') {
            console.log(`Intercepted GraphQL response: ${url}`);
            const responseData = await response.json();
            console.log('Full GraphQL response:', JSON.stringify(responseData, null, 2));
            
            // Look for various possible data structures
            if (responseData.data) {
              const dataKeys = Object.keys(responseData.data);
              console.log('GraphQL data keys:', dataKeys);
              
              // Check for any data structure that might contain departure info
              for (const key of dataKeys) {
                const data = responseData.data[key];
                if (Array.isArray(data) && data.length > 0) {
                  const firstItem = data[0];
                  if (firstItem && (firstItem.departuretime || firstItem.header || firstItem.destination || firstItem.time)) {
                    console.log(`Found departure data in ${key} with ${data.length} entries`);
                    graphqlData = data;
                    break;
                  }
                }
              }
              
              if (!graphqlData) {
                if (responseData.data.getBusDV5) {
                  console.log(`Found getBusDV5 with ${responseData.data.getBusDV5.length} departures`);
                  graphqlData = responseData.data.getBusDV5;
                } else if (responseData.data.getDepartures) {
                  console.log(`Found getDepartures with ${responseData.data.getDepartures.length} departures`);
                  graphqlData = responseData.data.getDepartures;
                } else if (responseData.data.departures) {
                  console.log(`Found departures with ${responseData.data.departures.length} departures`);
                  graphqlData = responseData.data.departures;
                } else if (responseData.data.lightRailDV) {
                  console.log(`Found lightRailDV with ${responseData.data.lightRailDV.length} departures`);
                  graphqlData = responseData.data.lightRailDV;
                } else if (responseData.data.getSystemStatus) {
                  console.log('Found system status data (no departures)');
                } else {
                  console.log('GraphQL response structure:', JSON.stringify(responseData, null, 2));
                }
              }
            }
          }
        } catch (error) {
          console.log('Error processing response:', error.message);
        }
      });

      console.log('Navigating to NJ Transit page...');
      await page.goto('https://www.njtransit.com/dv-to?line=Hudson-Bergen%20Light%20Rail&origin=ESSEX%20STREET%20LIGHT%20RAIL%20STATION', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      // Wait for page to load
      console.log('Waiting for data to load...');
      await page.waitForSelector('body', { timeout: 10000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to interact with elements that might trigger departure data loading
      try {
        // Inspect the page content to see what's actually loaded
        const pageContent = await page.evaluate(() => {
          const body = document.body.innerText;
          const departures = document.querySelectorAll('[class*="departure"], [class*="time"], [class*="train"], .schedule, .departure-time');
          
          // Look for any table or list elements that might contain departure data
          const tables = document.querySelectorAll('table, .table, [class*="schedule"], [class*="board"]');
          const lists = document.querySelectorAll('ul, ol, [class*="list"]');
          
          return {
            hasEssexStreet: body.includes('ESSEX STREET') || body.includes('Essex Street'),
            hasLightRail: body.includes('Light Rail'),
            hasDepartures: body.includes('departure') || body.includes('Departure'),
            departureElements: departures.length,
            tableElements: tables.length,
            listElements: lists.length,
            bodyLength: body.length,
            bodyPreview: body.substring(0, 1000),
            url: window.location.href,
            title: document.title
          };
        });
        this.log('Page analysis:', pageContent);
        
        // First switch to the Light Rail tab, then look for the "Get departures" button
        try {
          console.log('Switching to Light Rail tab...');
          
          // Look for and click the Light Rail tab to make it active - target the specific form tabs
          const lightRailTabClicked = await page.evaluate(() => {
            // Target the specific Rail/Light Rail tabs based on the debug output
            // Rail tab: index 144, id="__BVID__335___BV_tab_button__", className="nav-link active"
            // Light Rail tab: index 146, id="__BVID__343___BV_tab_button__", className="nav-link"
            
            const lightRailTab = document.getElementById('__BVID__343___BV_tab_button__');
            
            if (lightRailTab) {
              console.log('Found Light Rail tab by ID:', lightRailTab.id);
              console.log('Tab element details:', {
                tagName: lightRailTab.tagName,
                className: lightRailTab.className,
                id: lightRailTab.id,
                textContent: lightRailTab.textContent?.trim()
              });
              
              // Use multiple click strategies
              lightRailTab.focus();
              lightRailTab.click();
              
              // Dispatch additional events
              lightRailTab.dispatchEvent(new Event('click', { bubbles: true }));
              lightRailTab.dispatchEvent(new Event('mousedown', { bubbles: true }));
              lightRailTab.dispatchEvent(new Event('mouseup', { bubbles: true }));
              
              return true;
            } else {
              console.log('Light Rail tab not found by ID, trying selector approach...');
              
              // Fallback to text-based search for tabs in the form area
              const formTabs = Array.from(document.querySelectorAll('[role="tab"], .nav-link, button[id*="tab"]'));
              const lightRailFormTab = formTabs.find(tab => {
                const text = tab.textContent?.toLowerCase() || '';
                return text.trim() === 'light rail' && tab.id.includes('BV_tab_button');
              });
              
              if (lightRailFormTab) {
                console.log('Found Light Rail form tab:', lightRailFormTab.id);
                lightRailFormTab.focus();
                lightRailFormTab.click();
                lightRailFormTab.dispatchEvent(new Event('click', { bubbles: true }));
                return true;
              }
            }
            
            return false;
          });
          
          if (lightRailTabClicked) {
            console.log('Successfully clicked Light Rail tab');
            // Wait for tab switch to complete
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Verify the tab switch worked by checking the specific form tabs
            const tabSwitchVerification = await page.evaluate(() => {
              const railTab = document.getElementById('__BVID__335___BV_tab_button__');
              const lightRailTab = document.getElementById('__BVID__343___BV_tab_button__');
              
              return {
                railTabActive: railTab?.classList.contains('active') || false,
                lightRailTabActive: lightRailTab?.classList.contains('active') || false,
                railTabClasses: railTab?.className || 'not found',
                lightRailTabClasses: lightRailTab?.className || 'not found',
                activeTabsFound: Array.from(document.querySelectorAll('.nav-link.active')).map(tab => ({
                  id: tab.id,
                  text: tab.textContent?.trim(),
                  className: tab.className
                }))
              };
            });
            
            this.log('Tab switch verification:', tabSwitchVerification);
            
            if (!tabSwitchVerification.lightRailTabActive) {
              console.log('Light Rail tab still not active after click, trying programmatic activation...');
              
              // Try programmatic tab activation
              const programmaticActivation = await page.evaluate(() => {
                const lightRailTab = document.getElementById('__BVID__343___BV_tab_button__');
                const railTab = document.getElementById('__BVID__335___BV_tab_button__');
                
                if (lightRailTab && railTab) {
                  // Remove active class from rail tab
                  railTab.classList.remove('active');
                  railTab.setAttribute('aria-selected', 'false');
                  
                  // Add active class to light rail tab
                  lightRailTab.classList.add('active');
                  lightRailTab.setAttribute('aria-selected', 'true');
                  
                  // Trigger tab change events
                  lightRailTab.dispatchEvent(new Event('shown.bs.tab', { bubbles: true }));
                  
                  console.log('Programmatically activated Light Rail tab');
                  return true;
                }
                return false;
              });
              
              if (programmaticActivation) {
                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }
          } else {
            console.log('Could not find Light Rail tab button');
          }
          
          console.log('Looking for "Get departures" button...');
          
          // Check if we're on the Light Rail tab and look for form fields that need to be filled
          const formAnalysis = await page.evaluate(() => {
            // Look for any input fields, selects, or form elements
            const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
            const formInfo = inputs.map((input, i) => ({
              index: i,
              tagName: input.tagName,
              type: input.type,
              name: input.name,
              id: input.id,
              value: input.value,
              placeholder: input.placeholder,
              required: input.required,
              disabled: input.disabled
            }));
            
            // Check if there are any visible forms
            const forms = Array.from(document.querySelectorAll('form'));
            
            return {
              inputs: formInfo,
              formCount: forms.length,
              currentTab: document.querySelector('.nav-link.active')?.textContent?.trim() || 'unknown'
            };
          });
          
          this.log('Form analysis:', formAnalysis);
          
          // Check if we're on the correct tab before filling forms
          const currentTabStatus = await page.evaluate(() => {
            const railTab = document.getElementById('__BVID__335___BV_tab_button__');
            const lightRailTab = document.getElementById('__BVID__343___BV_tab_button__');
            
            // Also check visible form content
            const formContainer = document.querySelector('form, .form-container, [class*="form"]');
            const visibleInputs = Array.from(document.querySelectorAll('input:not([style*="display: none"]):not([style*="display:none"])'));
            
            return {
              railTabActive: railTab?.classList.contains('active') || false,
              lightRailTabActive: lightRailTab?.classList.contains('active') || false,
              formPresent: !!formContainer,
              visibleInputCount: visibleInputs.length,
              lineFieldVisible: !!document.getElementById('line'),
              originFieldVisible: !!document.getElementById('the-origin'),
              formTabContent: document.querySelector('.tab-content, [class*="tab-pane"]')?.innerText?.substring(0, 200) || 'not found'
            };
          });
          
          this.log('Current tab status before form fill:', currentTabStatus);
          
          if (!currentTabStatus.lightRailTabActive) {
            console.log('WARNING: Light Rail tab is not active, form filling may fail');
          }
          
          // Fill in the required form fields to enable the button
          console.log('Attempting to fill form fields...');
          
          // First fill the line field
          const lineFieldFilled = await page.evaluate(() => {
            const lineInput = document.getElementById('line');
            if (lineInput && !lineInput.disabled) {
              lineInput.focus();
              lineInput.value = 'Hudson-Bergen Light Rail';
              lineInput.dispatchEvent(new Event('input', { bubbles: true }));
              lineInput.dispatchEvent(new Event('change', { bubbles: true }));
              lineInput.dispatchEvent(new Event('blur', { bubbles: true }));
              console.log('Filled line field with:', lineInput.value);
              return true;
            } else {
              console.log('Line input not found or disabled');
              return false;
            }
          });
          
          if (lineFieldFilled) {
            // Wait for the origin field to be enabled after line selection
            console.log('Waiting for origin field to be enabled...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Now fill the origin field
            const originFieldFilled = await page.evaluate(() => {
              const originInput = document.getElementById('the-origin');
              if (originInput) {
                // Force enable if still disabled
                originInput.disabled = false;
                originInput.focus();
                originInput.value = 'ESSEX STREET LIGHT RAIL STATION';
                originInput.dispatchEvent(new Event('input', { bubbles: true }));
                originInput.dispatchEvent(new Event('change', { bubbles: true }));
                originInput.dispatchEvent(new Event('blur', { bubbles: true }));
                console.log('Filled origin field with:', originInput.value);
                return true;
              } else {
                console.log('Origin input not found');
                return false;
              }
            });
            
            this.log('Form filling results:', { lineFieldFilled, originFieldFilled });
            
            // Wait for form validation to complete
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Check if button is now enabled
            const buttonStatus = await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
              const submitButton = buttons.find(btn => {
                const text = btn.textContent?.toLowerCase() || btn.value?.toLowerCase() || '';
                return text.includes('light rail') || text.includes('schedules') || text.includes('departures');
              });
              
              if (submitButton) {
                return {
                  found: true,
                  disabled: submitButton.disabled,
                  text: submitButton.textContent || submitButton.value,
                  className: submitButton.className
                };
              }
              return { found: false };
            });
            
            this.log('Submit button status after form fill:', buttonStatus);
          } else {
            console.log('Could not fill line field, form filling failed');
          }
          
          // Try to find and click the enabled button (index 17)
          const getDeparturesButtonClicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], .btn, input[type="submit"]'));
            
            // First try to find the specific enabled button (index 17 from debug output)
            const enabledButton = buttons.find(btn => {
              const text = btn.textContent?.toLowerCase() || btn.value?.toLowerCase() || '';
              return text.includes('get departures') && !btn.disabled && !btn.classList.contains('disabled');
            });
            
            if (enabledButton) {
              console.log('Found enabled button with text:', enabledButton.textContent || enabledButton.value);
              console.log('Button classes:', enabledButton.className);
              console.log('Button disabled:', enabledButton.disabled);
              
              // Multiple click strategies
              enabledButton.focus();
              enabledButton.click();
              enabledButton.dispatchEvent(new Event('click', { bubbles: true }));
              enabledButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              
              return true;
            }
            
            // Fallback: try any departures button that's not explicitly disabled
            const fallbackButton = buttons.find(btn => {
              const text = btn.textContent?.toLowerCase() || btn.value?.toLowerCase() || '';
              return (text.includes('get departures') || text.includes('departures')) && !btn.disabled;
            });
            
            if (fallbackButton) {
              console.log('Found fallback button with text:', fallbackButton.textContent || fallbackButton.value);
              fallbackButton.focus();
              fallbackButton.click();
              return true;
            }
            
            console.log('No enabled departures button found');
            return false;
          });
          
          if (getDeparturesButtonClicked) {
            console.log('Successfully clicked "Get departures" button');
            
            // Wait for the departure data to load
            console.log('Waiting for departure data to load after button click...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Check if departure data appeared in the DOM
            const postClickContent = await page.evaluate(() => {
              const body = document.body.innerText;
              const tables = document.querySelectorAll('table, .table, [class*="schedule"], [class*="board"], [class*="departure"]');
              const timeElements = document.querySelectorAll('[class*="time"], [class*="minute"]');
              
              return {
                hasEssexStreet: body.includes('ESSEX STREET') || body.includes('Essex Street'),
                hasHoboken: body.includes('HOBOKEN') || body.includes('Hoboken'),
                hasWestSide: body.includes('WEST SIDE') || body.includes('West Side'),
                hasTimes: /\d{1,2}:\d{2}/.test(body),
                tableCount: tables.length,
                timeElementCount: timeElements.length,
                bodyLength: body.length,
                relevantText: body.match(/.{0,100}(departure|time|hoboken|west side|essex).{0,100}/gi) || []
              };
            });
            
            this.log('Post-click page analysis:', postClickContent);
          } else {
            console.log('Could not find "Get departures" button');
            
            // List all buttons for debugging
            const allButtons = await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button, [role="button"], .btn, input[type="submit"]'));
              return buttons.map((btn, i) => ({
                index: i,
                text: btn.textContent?.trim() || btn.value || '',
                className: btn.className,
                type: btn.type
              }));
            });
            console.log('Available buttons:', allButtons);
          }
        } catch (error) {
          console.log('Button interaction error:', error.message);
        }
        
      } catch (error) {
        console.log('Interaction error:', error.message);
        // Continue anyway
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      await page.close();

      if (graphqlData && graphqlData.length > 0) {
        const processed = this.processData(graphqlData);
        this.lastData = {
          ...processed,
          lastUpdated: new Date().toISOString(),
          status: 'success'
        };
        console.log(`Scrape completed successfully. Found ${processed.northbound.length} northbound and ${processed.southbound.length} southbound trains`);
      } else {
        console.log('No data found in GraphQL response');
        this.lastData.status = 'no_data';
      }

    } catch (error) {
      console.error('Scraping error:', error);
      this.lastData.status = 'error';
      this.lastData.error = error.message;
    } finally {
      this.isRunning = false;
    }

    return this.lastData;
  }

  processData(rawData) {
    const northbound = [];
    const southbound = [];

    for (const train of rawData) {
      const departure = {
        destination: train.header,
        time: train.departuretime,
        status: train.departurestatus,
        scheduledTime: train.schedDepTime
      };

      // Classify by destination
      if (train.header.includes('HOBOKEN') || train.header.includes('NEWPORT') || train.header.includes('PAVONIA')) {
        northbound.push(departure);
      } else if (train.header.includes('8TH STREET') || train.header.includes('WEST SIDE') || train.header.includes('TONNELLE')) {
        southbound.push(departure);
      }
    }

    return {
      northbound: northbound.slice(0, 3), // Next 3 trains
      southbound: southbound.slice(0, 3)  // Next 3 trains
    };
  }

  startScheduledScraping() {
    console.log(`🕒 Starting scheduled scraping every ${this.scrapeIntervalMinutes} minutes`);
    
    // Do an initial scrape
    this.scrapeData().then(() => {
      console.log('Initial scheduled scrape completed');
    }).catch(err => {
      console.error('Initial scrape failed:', err.message);
    });
    
    // Set up the interval
    this.scrapeInterval = setInterval(() => {
      console.log('🔄 Running scheduled scrape...');
      this.scrapeData().then(() => {
        console.log('Scheduled scrape completed');
      }).catch(err => {
        console.error('Scheduled scrape failed:', err.message);
      });
    }, this.scrapeIntervalMinutes * 60 * 1000);
  }

  stopScheduledScraping() {
    if (this.scrapeInterval) {
      clearInterval(this.scrapeInterval);
      this.scrapeInterval = null;
      console.log('⏹️ Stopped scheduled scraping');
    }
  }

  // Calculate time until departure from cached data
  calculateTimeUntilDeparture(departureTime, scheduledTime) {
    if (!departureTime && !scheduledTime) return 'Unknown';
    
    try {
      // Try to parse the time format from the API response
      const now = new Date();
      let targetTime;
      
      // Handle different time formats that might come from the API
      if (scheduledTime && scheduledTime.includes('/')) {
        // Format like "8/2/2025 11:27:00 PM"
        targetTime = new Date(scheduledTime);
      } else if (departureTime) {
        // Format like "11:27 PM" - assume today
        const timeMatch = departureTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (timeMatch) {
          let [_, hours, minutes, ampm] = timeMatch;
          hours = parseInt(hours);
          minutes = parseInt(minutes);
          
          // Convert to 24-hour format
          if (ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
          if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
          
          targetTime = new Date();
          targetTime.setHours(hours, minutes, 0, 0);
          
          // If the time has passed today, assume it's tomorrow
          if (targetTime < now) {
            targetTime.setDate(targetTime.getDate() + 1);
          }
        }
      }
      
      if (!targetTime || isNaN(targetTime.getTime())) {
        return departureTime || 'Unknown';
      }
      
      const diffMs = targetTime.getTime() - now.getTime();
      const diffMinutes = Math.round(diffMs / (1000 * 60));
      
      if (diffMinutes <= 0) {
        return 'Now';
      } else if (diffMinutes === 1) {
        return 'in 1 min';
      } else if (diffMinutes < 60) {
        return `in ${diffMinutes} mins`;
      } else {
        const hours = Math.floor(diffMinutes / 60);
        const mins = diffMinutes % 60;
        if (mins === 0) {
          return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
        } else {
          return `in ${hours}h ${mins}m`;
        }
      }
    } catch (error) {
      console.log('Error calculating time until departure:', error.message);
      return departureTime || 'Unknown';
    }
  }

  // Get cached data with real-time calculations
  getCachedData() {
    if (!this.lastData.lastUpdated || this.lastData.status !== 'success') {
      return {
        ...this.lastData,
        message: 'No data available yet. Waiting for first scrape...'
      };
    }

    // Calculate real-time status for all departures
    const processedData = {
      ...this.lastData,
      northbound: this.lastData.northbound.map(train => ({
        ...train,
        calculatedStatus: this.calculateTimeUntilDeparture(train.time, train.scheduledTime)
      })),
      southbound: this.lastData.southbound.map(train => ({
        ...train,
        calculatedStatus: this.calculateTimeUntilDeparture(train.time, train.scheduledTime)
      }))
    };

    return processedData;
  }

  async close() {
    this.stopScheduledScraping();
    if (this.browser) {
      await this.browser.close();
    }
  }
}

class FerryScheduler {
  constructor() {
    // NY Waterway Paulus Hook to WTC schedule
    this.weekdaySchedule = [
      // Morning rush: 6:00-9:00 AM (every 7-8 minutes)
      360, 367, 375, 382, 390, 397, 405, 412,
      420, 427, 435, 442, 450, 457, 465, 472,
      480, 487, 495, 502, 510, 517, 525, 532, 540,
      // Mid-day: 9:15 AM - 5:45 PM (every 15 minutes)
      555, 570, 585, 600, 615, 630, 645, 660, 675, 690, 705, 720, 735, 750, 765, 780, 795, 810, 825, 840, 855, 870, 885, 900, 915, 930, 945, 960, 975, 990, 1005, 1020, 1035, 1050, 1065,
      // Evening: 6:00-10:45 PM (hourly plus 15,30)
      1080, 1095, 1110, 1125, 1140, 1155, 1170, 1185, 1200, 1215, 1230, 1245, 1260, 1275, 1290, 1305, 1320, 1335, 1350, 1365, 1380, 1395, 1410, 1425, 1440, 1455, 1470, 1485, 1500, 1515, 1530, 1545, 1560, 1575, 1590, 1605, 1620, 1635, 1645
    ];
    
    // Weekend schedule: 10:10 AM - 7:40 PM (every 30 minutes)
    this.weekendSchedule = [
      610, 640, 670, 700, 730, 760, 790, 820, 850, 880, 910, 940, 970, 1000, 1030, 1060, 1090, 1120, 1150, 1180
    ];
  }
  
  getCurrentTime() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }
  
  isWeekday() {
    return new Date().getDay() >= 1 && new Date().getDay() <= 5;
  }
  
  formatTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
  }
  
  getNextDeparture() {
    const currentTime = this.getCurrentTime();
    const schedule = this.isWeekday() ? this.weekdaySchedule : this.weekendSchedule;
    
    // Find next departure
    const nextDeparture = schedule.find(time => time > currentTime);
    
    if (!nextDeparture) {
      return {
        status: 'Service ended',
        nextDepartureTime: '--:--',
        minutesUntil: null,
        scheduleType: this.isWeekday() ? 'Weekday' : 'Weekend',
        lastUpdated: new Date().toISOString()
      };
    }
    
    const minutesUntil = nextDeparture - currentTime;
    let status;
    
    if (minutesUntil <= 0) {
      status = 'Departed';
    } else if (minutesUntil === 1) {
      status = 'in 1 min';
    } else {
      status = `in ${minutesUntil} mins`;
    }
    
    return {
      status: status,
      nextDepartureTime: this.formatTime(nextDeparture),
      minutesUntil: minutesUntil,
      scheduleType: this.isWeekday() ? 'Weekday' : 'Weekend',
      lastUpdated: new Date().toISOString()
    };
  }
  
  getAllUpcomingDepartures(count = 3) {
    const currentTime = this.getCurrentTime();
    const schedule = this.isWeekday() ? this.weekdaySchedule : this.weekendSchedule;
    
    const upcoming = schedule
      .filter(time => time > currentTime)
      .slice(0, count)
      .map(time => ({
        departureTime: this.formatTime(time),
        minutesUntil: time - currentTime,
        status: time - currentTime === 1 ? 'in 1 min' : `in ${time - currentTime} mins`
      }));
    
    return {
      upcoming: upcoming,
      scheduleType: this.isWeekday() ? 'Weekday' : 'Weekend',
      lastUpdated: new Date().toISOString()
    };
  }
}

// Initialize scraper and ferry scheduler
const scraper = new LightRailScraper();
const ferryScheduler = new FerryScheduler();

// Routes
app.get('/', (req, res) => {
  res.json({
    service: 'NJ Transit Light Rail & Ferry Scraper',
    status: 'running',
    endpoints: {
      'light-rail-departures': '/api/departures',
      'light-rail-status': '/api/status',
      'ferry-next': '/api/ferry',
      'ferry-upcoming': '/api/ferry/upcoming',
      northbound: '/api/northbound',
      southbound: '/api/southbound'
    }
  });
});

app.get('/api/departures', (req, res) => {
  try {
    const data = scraper.getCachedData();
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get cached data',
      message: error.message
    });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    status: scraper.lastData.status,
    lastUpdated: scraper.lastData.lastUpdated,
    isRunning: scraper.isRunning,
    scheduledScraping: !!scraper.scrapeInterval,
    scrapeIntervalMinutes: scraper.scrapeIntervalMinutes,
    nextScrapeIn: scraper.scrapeInterval ? `${scraper.scrapeIntervalMinutes} minutes or less` : 'Not scheduled'
  });
});

// Manual scrape endpoint (for testing/debugging)
app.post('/api/scrape', async (req, res) => {
  try {
    console.log('📡 Manual scrape requested via API');
    const data = await scraper.scrapeData();
    res.json({
      message: 'Manual scrape completed',
      data: data
    });
  } catch (error) {
    res.status(500).json({
      error: 'Manual scrape failed',
      message: error.message
    });
  }
});

// Simplified endpoints for Home Assistant
app.get('/api/northbound', (req, res) => {
  try {
    const data = scraper.getCachedData();
    const next = data.northbound.length > 0 ? data.northbound[0] : null;
    res.json({
      status: next ? next.calculatedStatus || next.status : 'No trains',
      destination: next ? next.destination : '',
      time: next ? next.time : '',
      lastUpdated: data.lastUpdated,
      originalStatus: next ? next.status : '',
      scheduledTime: next ? next.scheduledTime : ''
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ferry API endpoints
app.get('/api/ferry', (req, res) => {
  try {
    const ferryData = ferryScheduler.getNextDeparture();
    res.json(ferryData);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get ferry data',
      message: error.message
    });
  }
});

app.get('/api/ferry/upcoming', (req, res) => {
  try {
    const count = parseInt(req.query.count) || 3;
    const ferryData = ferryScheduler.getAllUpcomingDepartures(count);
    res.json(ferryData);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get upcoming ferry data',
      message: error.message
    });
  }
});

app.get('/api/southbound', (req, res) => {
  try {
    const data = scraper.getCachedData();
    const next = data.southbound.length > 0 ? data.southbound[0] : null;
    res.json({
      status: next ? next.calculatedStatus || next.status : 'No trains',
      destination: next ? next.destination : '',
      time: next ? next.time : '',
      lastUpdated: data.lastUpdated,
      originalStatus: next ? next.status : '',
      scheduledTime: next ? next.scheduledTime : ''
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize and start server
async function start() {
  try {
    await scraper.init();
    
    app.listen(PORT, () => {
      console.log(`🚋 Light Rail & Ferry API running on port ${PORT}`);
      console.log(`📊 API endpoints:`);
      console.log(`   Light Rail:`);
      console.log(`   - http://localhost:${PORT}/api/departures`);
      console.log(`   - http://localhost:${PORT}/api/northbound`);
      console.log(`   - http://localhost:${PORT}/api/southbound`);
      console.log(`   - http://localhost:${PORT}/api/status`);
      console.log(`   Ferry:`);
      console.log(`   - http://localhost:${PORT}/api/ferry`);
      console.log(`   - http://localhost:${PORT}/api/ferry/upcoming`);
      console.log(`⚡ Features:`);
      console.log(`   - Scheduled light rail scraping every ${scraper.scrapeIntervalMinutes} minutes`);
      console.log(`   - Real-time ferry schedule calculations`);
      console.log(`   - Instant API responses from cached data`);
      console.log(`   - Real-time countdown calculations`);
      
      // Start scheduled scraping
      setTimeout(() => {
        scraper.startScheduledScraping();
      }, 2000);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await scraper.close();
  process.exit(0);
});

start();