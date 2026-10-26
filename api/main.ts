import {colorApi} from './server';
const key=process.env.COLOR_API_KEY;if(!key)throw Error('COLOR_API_KEY is required');colorApi(key).listen(Number(process.env.PORT||8081),'127.0.0.1',()=>console.log('Color API ready on loopback'));
