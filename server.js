/**
 * Created by mar on 3/3/17.
 */

'use strict';

import "babel-polyfill";
import { Server as WebSocketServer } from 'uws';
import { MongoClient, ObjectId } from 'mongodb';
import braintree from 'braintree';

// GENERATOR makes objects easy to loop over in key value fashion.
function* it(obj) {
    for (let key of Object.keys(obj)) {
        yield [key, obj[key]];
    }
}


// BRAINTREE SERVER IMPLEMENTATION
const braintreeCredentials = require('../keys/braintree.json');
const gateway = braintree.connect({
    environment: braintree.Environment.Sandbox,
    merchantId: braintreeCredentials.merchantId,
    publicKey: braintreeCredentials.publicKey,
    privateKey: braintreeCredentials.privateKey
});


// MONGO WRAPPER
const mongoCredentials = require('../keys/mongo.json');
const mongoUrl = 'mongodb://'+mongoCredentials.user+':'+mongoCredentials.pwd+'@localhost:27017/honeymoon?authMechanism='+mongoCredentials.authMechanism+'&authSource='+mongoCredentials.authSource;
const getConnection = () => {
    return new Promise((resolve, reject) => {
        MongoClient.connect(mongoUrl, (err, db) => {
            if(err) {
                reject('Error connecting to database.');
            }
            else {
                resolve(db);
            }
        });
    });
};


// APPLICATION SERVER
let currentConnections = {};
let currentPushSubscriptions = {};

const wss = new WebSocketServer({ 
    port: 8081
}, () => {
   console.log("Websocket Server started on port: 8081"); 
});
wss.on('connection', ws => {
    // get some data about this connection
    ws.data = {};
    ws.data.userAgent = ws.upgradeReq.headers['user-agent'];
    ws.data.ip = ws.upgradeReq.headers['x-real-ip'];
    ws.data.ctime = new Date();
    ws.data.nickname = 'anonymous';

    // Set up some handlers for socket events
    ws.on('message', message => {
        try {
            let action = JSON.parse(message);
            
            //kick off the process.
            dataLayer(ws, action);
        } catch (e) {
            // something went wrong...
            console.error(e.message);
        }
    });
    
    ws.on('close', () => {
        dataLayer(ws, {
            type: "CONNECTION_CLOSED"
        });
    });
});

/**
 * Update data in DB.
 * 
 * @param ws
 * @param action
 */
const dataLayer = (ws, action) => {
    switch(action.type) {
        case 'CONNECTION_OPEN':
            
            return new Promise((resolve, reject) => {
                gateway.clientToken.generate({}, (err, response) => {
                    if (err) {
                        reject(err);
                    }
                    
                    resolve(response);
                });  
            }).then((response) => {
                ws.data.clientToken = response.clientToken;
                
                // lets get a db connection
                return getConnection();
            }).then((db) => {
                // insert a new annonymous user
                return db.collection('users').insertOne(ws.data).then((result) => {
                    // lets build them an initial state...
                    let user = db.collection('users').findOne({ _id: ObjectId(result.insertedId) });
                    let registry = db.collection('registry').aggregate([{
                        $lookup: {
                            from: "gifts",
                            localField: "_id",
                            foreignField: "registryId",
                            as: "comments"
                        }
                    },
                    {
                        $project: {
                            "comments._id": 0,
                            "comments.amount": 0,
                            "comments.registryId": 0
                        }
                    }]).toArray();

                    return Promise.all([user, registry]);
                });
            }).then((values) => {
                ws.data.user = values[0];
                ws.data.registry = values[1];
                
                // unset the values on the data object bc they are now in the data.user object.
                delete ws.data.clientToken;
                delete ws.data.ctime;
                delete ws.data.ip;
                delete ws.data.userAgent;
                delete ws.data._id;
                delete ws.data.nickname;
                
                action = {
                    type: "CONNECTION_OPENED",
                    state: ws.data
                };
                
                // Store handle to this connection for later
                currentConnections[ws.data.user._id] = ws;
                notificationLayer(ws, action);

            }).catch((error) => {
                console.error(error);
                
                action = {
                    type: "CONNECTION_OPEN_ERROR",
                    message: error.message
                };
                notificationLayer(ws, action);
            });
            break;
        
        case 'CONNECTION_CLOSED':
            // remove from currentConnections
            delete currentConnections[ws.data.user._id];
            action = { 
                type: "CONNECTION_CLOSED",
                userId: ws.data.user._id
            };
            break;
        
        case 'GIFT_CREATE':
            //TODO: move validation to it's own layer before dataLayer
            const requiredArgs = {
                amount: 'number',
                paymentMethodNonce: 'string',
                nickname: 'string',
                comment: 'string',
                registryId: 'string'
            };

            for (let [arg, type] of it(requiredArgs)) {
                if (!action.data.hasOwnProperty(arg)) {
                    action = {
                        type: "GIFT_CREATE_ERROR",
                        message: "Missing argument: "+arg
                    };
                    notificationLayer(ws, action);
                    return;
                }
                
                if (typeof action.data[arg] !== type) {
                    //try to convert to that type
                    try {
                        switch (type) {
                            case 'number':
                                action.data[arg] = Number(action.data[arg]);
                                break;
                            case 'string':
                                action.data[arg] = String(action.data[arg]);
                        }
                    }
                    catch (error) {
                        action = {
                            type: "GIFT_CREATE_ERROR",
                            message: error.message
                        };
                        notificationLayer(ws, action);
                        return;
                    }
                }
            }
            
            // attempt to make trxn with gateway
            return new Promise((resolve, reject) => {
                gateway.transaction.sale({
                    amount: action.data.amount,
                    paymentMethodNonce: action.data.paymentMethodNonce,
                    options: {
                        submitForSettlement: true
                    }
                }, (err, result) => {
                    if (err) {
                        reject(err);
                    }
                    else if (!result.success) {
                        reject(result.errors.deepErrors());
                    }
                    else {
                        resolve(result);
                    }
                });
            }).then((result) => {
                action.data.transaction = result.transaction;
                
                return getConnection();
            }).then((db) => {
                // update user's nickname with gift's nickname data
                let res0 = db.collection('users').updateOne({
                    _id: ObjectId(ws.data.user._id)
                },
                {
                    $set: {
                        nickname: action.data.nickname
                    }
                });

                // insert new gift
                const gift = {
                    userId: ObjectId(ws.data.user._id),
                    amount: action.data.amount,
                    comment: action.data.comment,
                    registryId: ObjectId(action.data.registryId),
                    transaction: action.data.transaction
                };
                let res1 = db.collection('gifts').insertOne(gift);
                
                // Get the registry item
                let res2 = db.collection('registry').findOne({ _id: ObjectId(action.data.registryId) });
                
                return Promise.all([res0, res1, res2]).then((results) => {
                    
                    const newTotalGiven = results[2].totalGiven + action.data.amount;
                    let newGoalReached = false;
                    
                    if(newTotalGiven >= results[2].totalPrice) {
                        newGoalReached = true;
                    }
                    
                    // update registry item that this is gifted towards
                    return db.collection('registry').updateOne({
                        _id: ObjectId(action.data.registryId)
                    },
                    {
                        $set: {
                            totalGiven: newTotalGiven,
                            goalReached: newGoalReached
                        }
                    });
                }).then((result3) => {
                    let registry = db.collection('registry').aggregate([{
                        $lookup: {
                            from: "gifts",
                            localField: "_id",
                            foreignField: "registryId",
                            as: "comments"
                        }
                    },
                        {
                            $project: {
                                "comments._id": 0,
                                "comments.amount": 0,
                                "comments.registryId": 0,
                                "comments.transaction": 0
                            }
                        }]).toArray();

                    let user = db.collection('users').findOne({ _id: ObjectId(ws.data.user._id) });

                    return Promise.all([registry, user]);
                });
            }).then((results) => {
                action = {
                    type: "GIFT_CREATED",
                    data: {
                        registry: results[0],
                        user: results[1]
                    }
                };
                notificationLayer(ws, action);

            }).catch((error) => {
                action = {
                    type: "GIFT_CREATE_ERROR",
                    message: error.message
                };
                notificationLayer(ws, action);
            });
            break;
    }
};

/**
 * Notify the other users that need to know about this action.
 * 
 * @param ws
 * @param action
 */
const notificationLayer = (ws, action) => {
    let userIds;
    
    switch(action.type) {
        case 'CONNECTION_OPENED':
            // the user just opened the app, lets tell the other users he's online.
            userIds = 'connected';
            notificationSender(userIds, action);
            break;
            
        case 'CONNECTION_OPEN_ERROR':
            userIds = [ws.data.user._id];
            notificationSender(userIds, action);
            break;
        
        case 'CONNECTION_CLOSED':
            // the user just closed the connection.
            userIds = 'connected';
            notificationSender(userIds, action);
            break;
            
        case 'GIFT_CREATED':
            userIds = 'connected';
            notificationSender(userIds, action);
            break;
            
        case 'GIFT_CREATE_ERROR':
            userIds = [ws.data.user._id];
            notificationSender(userIds, action);
    }
};

const notificationSender = (userIds, action) => {
    console.log('Trying to send notification type: '+action.type+' to users: '+userIds);
    
    // loop through all connected and subscribed
    if (userIds === 'all') {
        for (let [userId, ws] of it(currentConnections)) {
            ws.send(JSON.stringify(action));
        }

        for (let [userId, subscription] of it(currentPushSubscriptions)) {
            // TODO: send notification to FCM via XMPP request...
        }
    }
    // loop through all connected
    else if (userIds === 'connected') {
        for (let [userId, ws] of it(currentConnections)) {
            ws.send(JSON.stringify(action));
        }
    }
    // must be an array, lets send to specific users
    else {
        for (let uid in userIds) {
            let uid = userIds[uid];

            // first check for this user in currentConnections to see if we can notify them via a websocket.
            if (currentConnections.hasOwnProperty(uid)) {
                console.log('Found uid: '+uid+' in current connections');
                currentConnections[uid].send(JSON.stringify(action));
            }

            // if they aren't in there lets see if they are a Push subscriber, maybe we can contact them that way.
            else if (currentPushSubscriptions.hasOwnProperty(uid)) {
                console.log('Found uid: '+uid+' in push subscriptions');
                //TODO: send notification to FCM via XMPP request...
            }

            // this user is not reachable :(
            else {
                console.log('User: '+uid+' is unreachable :(');
                //TODO: maybe do something here in the future...
            }
        }
    }
    
    console.log(''); //create an extra line seperation in logs
};